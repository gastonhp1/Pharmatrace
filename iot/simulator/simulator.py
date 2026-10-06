#!/usr/bin/env python3
"""Virtual PharmaTrace valija: produces signed readings exactly like the real device would.

It uses the same wire format (iot/docs/READING_FORMAT.md) and the same signature scheme as the
ESP32 + ATECC608 (ECDSA P-256 over SHA-256, raw r||s), so the gateway cannot tell the difference.

    python simulator.py keygen --key valija.pem            # prints the public key to register
    python simulator.py run --key valija.pem --device-id VAL-001 --scenario excursion

Only the standard library and `cryptography` are needed.
"""
import argparse
import json
import os
import random
import struct
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

READING_FORMAT = ">IIhHBii"  # ts, seq, tempCenti, humCenti, flags, latE5, lonE5
READING_SIZE = struct.calcsize(READING_FORMAT)  # 21

FLAG_LID_OPENED = 0x01
FLAG_SHOCK = 0x02
FLAG_SEAL_BROKEN = 0x04

MAX_PER_REQUEST = 200  # the gateway's limit


# ---------------------------------------------------------------- wire format and signature

def pack_reading(ts, seq, temp_centi, hum_centi, flags, lat_e5, lon_e5):
    return struct.pack(READING_FORMAT, ts, seq, temp_centi, hum_centi, flags, lat_e5, lon_e5)


def sign_payload(private_key, payload):
    """ECDSA P-256 over SHA-256(payload), as the raw 64 bytes r || s."""
    der = private_key.sign(payload, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def public_key_hex(private_key):
    """The 64 bytes X || Y that DeviceRegistry stores, as 0x-prefixed hex."""
    numbers = private_key.public_key().public_numbers()
    return "0x" + (numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")).hex()


def load_or_create_key(path):
    if os.path.exists(path):
        with open(path, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    return key


# ---------------------------------------------------------------- scenarios

def build_readings(scenario, count, interval, start_ts, first_seq, lat=-34.6037, lon=-58.3816, rng=None):
    """Returns `count` readings (dicts) starting at `start_ts`, one every `interval` seconds.

    normal     stays around 5 C
    excursion  the middle third of the trip runs at about 10 C (above the 2-8 C range)
    tamper     normal temperatures; the lid is opened at 60% of the trip and the seal is broken
               at 75% (the flags stay set from then on, like the real sensors)
    """
    rng = rng or random.Random(42)
    readings = []
    for i in range(count):
        progress = i / max(count - 1, 1)

        temp = 5.0 + rng.uniform(-0.6, 0.6)
        if scenario == "excursion" and 1 / 3 <= progress < 2 / 3:
            temp = 10.0 + rng.uniform(-0.5, 0.5)

        flags = 0
        if scenario == "tamper":
            if progress >= 0.60:
                flags |= FLAG_LID_OPENED
            if progress >= 0.75:
                flags |= FLAG_SEAL_BROKEN

        readings.append(
            {
                "ts": start_ts + i * interval,
                "seq": first_seq + i,
                "temp_centi": round(temp * 100),
                "hum_centi": round((55 + rng.uniform(-3, 3)) * 100),
                "flags": flags,
                "lat_e5": round(lat * 1e5) + i,
                "lon_e5": round(lon * 1e5) - i,
            }
        )
    return readings


def sign_readings(private_key, readings):
    items = []
    for r in readings:
        payload = pack_reading(
            r["ts"], r["seq"], r["temp_centi"], r["hum_centi"], r["flags"], r["lat_e5"], r["lon_e5"]
        )
        items.append(
            {"payload": "0x" + payload.hex(), "signature": "0x" + sign_payload(private_key, payload).hex()}
        )
    return items


# ---------------------------------------------------------------- gateway client

def post_json(url, body):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


# The device's sequence counter lives in non-volatile memory on the real thing; here, in a file.
def next_seq(seq_path):
    if os.path.exists(seq_path):
        with open(seq_path) as f:
            return int(f.read().strip()) + 1
    return 1


def save_seq(seq_path, seq):
    with open(seq_path, "w") as f:
        f.write(str(seq))


# ---------------------------------------------------------------- commands

def cmd_keygen(args):
    existed = os.path.exists(args.key)
    key = load_or_create_key(args.key)
    print(f"{'Using existing' if existed else 'Created'} key: {args.key}")
    print(f"Public key (register it in DeviceRegistry): {public_key_hex(key)}")


def cmd_run(args):
    key = load_or_create_key(args.key)
    seq_path = args.seq_file or f"{args.key}.seq"
    first_seq = next_seq(seq_path)

    # The trip ended `now`: the readings are in the past, one every `interval` seconds, so the
    # whole run can be uploaded at once without waiting for it to happen in real time.
    start_ts = int(time.time()) - (args.count - 1) * args.interval
    readings = build_readings(args.scenario, args.count, args.interval, start_ts, first_seq, args.lat, args.lon)
    items = sign_readings(key, readings)

    if args.dry_run:
        print(json.dumps({"deviceId": args.device_id, "readings": items}, indent=2))
        return 0

    url = args.gateway.rstrip("/") + "/api/iot/readings"
    accepted = 0
    for offset in range(0, len(items), MAX_PER_REQUEST):
        chunk = items[offset : offset + MAX_PER_REQUEST]
        status, body = post_json(url, {"deviceId": args.device_id, "readings": chunk})
        if status != 200:
            print(f"Gateway answered {status}: {body.get('error', body)}", file=sys.stderr)
            return 1
        accepted += body["accepted"]
        for rejection in body["rejected"]:
            print(f"  rejected #{offset + rejection['index']}: {rejection['reason']}", file=sys.stderr)

    save_seq(seq_path, first_seq + len(readings) - 1)
    print(f"Sent {len(readings)} readings ({args.scenario}), the gateway accepted {accepted}.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    keygen = sub.add_parser("keygen", help="create the device key (once) and print its public key")
    keygen.add_argument("--key", default="valija.pem")
    keygen.set_defaults(func=cmd_keygen)

    run = sub.add_parser("run", help="generate signed readings and upload them to the gateway")
    run.add_argument("--key", default="valija.pem")
    run.add_argument("--device-id", required=True)
    run.add_argument("--scenario", choices=["normal", "excursion", "tamper"], default="normal")
    run.add_argument("--count", type=int, default=60, help="number of readings")
    run.add_argument("--interval", type=int, default=60, help="seconds between readings")
    run.add_argument("--gateway", default="http://localhost:3001")
    run.add_argument("--seq-file", help="where the sequence counter is kept (default: <key>.seq)")
    run.add_argument("--lat", type=float, default=-34.6037)
    run.add_argument("--lon", type=float, default=-58.3816)
    run.add_argument("--dry-run", action="store_true", help="print the request instead of sending it")
    run.set_defaults(func=cmd_run)

    args = parser.parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
