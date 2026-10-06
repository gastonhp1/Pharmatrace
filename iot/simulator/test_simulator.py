"""Run with:  python -m unittest iot/simulator/test_simulator.py   (or from this folder: python -m unittest)"""
import hashlib
import os
import sys
import tempfile
import unittest

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import simulator as sim  # noqa: E402

# Same vector as backend/test/iot.test.js: the gateway, the simulator and the firmware have to
# agree on these bytes and on the digest that gets signed.
VECTOR = dict(ts=1800000000, seq=7, temp_centi=450, hum_centi=5500, flags=0x05, lat_e5=-3460000, lon_e5=-5840000)
VECTOR_HEX = "6b49d2000000000701c2157c05ffcb3460ffa6e380"
VECTOR_SHA256 = "43ad8f8f0c31a6e3f656767b2bf00e225356013dc85e71f562b59a015ac0c455"


class WireFormat(unittest.TestCase):
    def test_matches_the_shared_vector(self):
        payload = sim.pack_reading(**VECTOR)
        self.assertEqual(len(payload), 21)
        self.assertEqual(payload.hex(), VECTOR_HEX)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), VECTOR_SHA256)

    def test_negative_values(self):
        payload = sim.pack_reading(1, 1, -1850, 0, 0, -1, -1)
        self.assertEqual(len(payload), 21)


class Signatures(unittest.TestCase):
    def setUp(self):
        self.key = ec.generate_private_key(ec.SECP256R1())

    def verify(self, public_hex, payload, signature):
        raw = bytes.fromhex(public_hex[2:])
        public = ec.EllipticCurvePublicNumbers(
            int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"), ec.SECP256R1()
        ).public_key()
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")
        public.verify(encode_dss_signature(r, s), payload, ec.ECDSA(hashes.SHA256()))

    def test_signature_is_raw_64_bytes_and_verifies_against_the_registered_key(self):
        payload = sim.pack_reading(**VECTOR)
        signature = sim.sign_payload(self.key, payload)
        public_hex = sim.public_key_hex(self.key)

        self.assertEqual(len(signature), 64)
        self.assertEqual(len(bytes.fromhex(public_hex[2:])), 64)
        self.verify(public_hex, payload, signature)  # raises if invalid

    def test_a_modified_payload_does_not_verify(self):
        payload = sim.pack_reading(**VECTOR)
        signature = sim.sign_payload(self.key, payload)
        with self.assertRaises(Exception):
            self.verify(sim.public_key_hex(self.key), payload[:-1] + b"\x00", signature)

    def test_key_file_is_created_once_and_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "valija.pem")
            first = sim.load_or_create_key(path)
            second = sim.load_or_create_key(path)
            self.assertEqual(sim.public_key_hex(first), sim.public_key_hex(second))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


class Scenarios(unittest.TestCase):
    def build(self, scenario, count=60):
        return sim.build_readings(scenario, count, 60, 1_800_000_000, first_seq=1)

    def test_timestamps_and_sequence_strictly_increase(self):
        readings = self.build("normal")
        self.assertEqual([r["seq"] for r in readings], list(range(1, 61)))
        self.assertTrue(all(b["ts"] - a["ts"] == 60 for a, b in zip(readings, readings[1:])))

    def test_normal_stays_inside_2_to_8_c(self):
        self.assertTrue(all(200 <= r["temp_centi"] <= 800 for r in self.build("normal")))

    def test_excursion_leaves_the_range_in_the_middle_third(self):
        readings = self.build("excursion", 60)
        outside = [i for i, r in enumerate(readings) if r["temp_centi"] > 800]
        self.assertEqual(len(outside), 20)
        self.assertEqual((outside[0], outside[-1]), (20, 39))

    def test_tamper_sets_lid_then_seal_flags_and_keeps_them(self):
        readings = self.build("tamper", 60)
        first_lid = next(i for i, r in enumerate(readings) if r["flags"] & sim.FLAG_LID_OPENED)
        first_seal = next(i for i, r in enumerate(readings) if r["flags"] & sim.FLAG_SEAL_BROKEN)
        self.assertLess(first_lid, first_seal)
        self.assertTrue(all(r["flags"] & sim.FLAG_SEAL_BROKEN for r in readings[first_seal:]))
        self.assertTrue(all(200 <= r["temp_centi"] <= 800 for r in readings))

    def test_signed_items_have_the_expected_shape(self):
        key = ec.generate_private_key(ec.SECP256R1())
        items = sim.sign_readings(key, self.build("normal", 3))
        self.assertEqual(len(items), 3)
        for item in items:
            self.assertEqual(len(bytes.fromhex(item["payload"][2:])), 21)
            self.assertEqual(len(bytes.fromhex(item["signature"][2:])), 64)


if __name__ == "__main__":
    unittest.main()
