# Authenticated opening of the PharmaBox

The backend side of the protocol designed in
[Pharmatrace-firmware `docs/unlock-protocol.md`](https://github.com/gastonhp1/Pharmatrace-firmware/blob/main/docs/unlock-protocol.md)
(option A: token over BLE). The phone side is the Android app,
[PharmaTrace-mobile](https://github.com/gastonhp1/PharmaTrace-mobile).

```
 PharmaBox                     App (PharmaTrace-mobile)            Backend (this repo)
   button → fresh nonce            │                                   │
   e-paper QR "PB1:id:nonce" ◄─ scan                                   │
                                   │── POST /api/box/unlock ──────────►│ session → user, org
                                   │   { qr }  Authorization: Bearer   │ GetDevice, ReadCargo
                                   │                                   │ box/policy.js, audit
                                   │◄──────── { token: 106 B hex } ────│ sign with UNLOCK_KEY_FILE
   ◄── BLE write `unlock` ─────────│                                   │
   verify, open, notify `status` ─►│ shows the result                  │
   next reading: FLAG 0x08                                             │
```

## Users

The rest of the API is custodial and protected by one shared `API_KEY`. That cannot ship inside an app in
the hands of drivers and pharmacists, and the token has to say *who* opened. So the API now has its own users,
one org (MSP) each:

```bash
cd backend
openssl rand -base64 48             # → SESSION_SECRET in .env
node scripts/user.js add dario DistMSP
node scripts/user.js add rita RegMSP
node scripts/user.js list
```

Passwords are hashed with scrypt; the file (`USERS_FILE`, default `backend/data/users.json`) is outside git.
`POST /api/auth/login { username, password }` returns `{ token, expiresAt, user: { username, mspId } }`; the
token is an HS256 JWT with a fixed algorithm (the header is never trusted) that lasts `SESSION_TTL_SECONDS`
(8 h by default). Five failed logins per user or per address in 15 minutes answer `429`.

This is deliberately small: users here act only on `/api/box`. Moving every write of the API from the API key
to per-user sessions (and checking that the user's org is the one the operation acts as) is the next step,
and in a real consortium it would be an OIDC provider per org rather than a JSON file.

## The signing key

A key of its own: not a Fabric identity, not the key of a box.

```bash
node scripts/unlock-key.js generate data/unlock-key.pem   # → UNLOCK_KEY_FILE
```

It prints the public key as `X||Y` hex and as the `include/unlock_key.h` the firmware expects. The same
public key is served at `GET /api/box/unlock-key`. Rotating it means re-flashing the boxes; keeping it in a
KMS/HSM is pending.

## Who can open

`backend/box/policy.js`, the only place the rule lives (the box checks only the signature):

| Situation | Can open |
| --- | --- |
| any | the regulator (`RegMSP`) |
| box deactivated (`SetDeviceActive false`) | only the regulator |
| box not monitoring a cargo | users of the org that registered it |
| cargo `OPEN` | users of the owner |
| cargo `IN_TRANSIT` | users of the recipient (`pendingTo`); **not** the sender or whoever carries it |
| cargo `DELIVERED` | users of the owner, which after `ReceiveCargo` is the org that received it |
| cargo `DISSOLVED` | users of the owner |

**Change from the firmware draft:** it left `DELIVERED` and `DISSOLVED` to the regulator only. With that rule
the pharmacy that just received a cargo could not unload the box while its monitoring was still open, so here
the owner can. If the intent was to force the monitoring to be closed first, tighten it in `policy.js`.

## Endpoints

| Method | Route | Auth | |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | — | `{ username, password }` → `{ token, expiresAt, user }` |
| GET | `/api/auth/me` | Bearer | `{ username, mspId }` |
| POST | `/api/box/unlock` | Bearer | `{ qr }` or `{ deviceId, nonce }` → `{ deviceId, token, issuedAt, expiresAt, cargoId, cargoState, reason }`; `403` with the reason when denied |
| GET | `/api/box/unlock-key` | — | `{ publicKey, curve, format }` |
| GET | `/api/box/audit` | Bearer, regulator | `?deviceId=&limit=` last decisions |

Every decision, granted or denied, is appended to `UNLOCK_AUDIT_FILE` with the user, org, actor tag
(`SHA-256("<msp>:<user>")[:8]`, the same 8 bytes that go in the token), box, cargo and reason.

## Token

Built by `backend/box/token.js`, byte for byte the layout in `pharma_unlock.h`: version, action,
`SHA-256(deviceId)[:8]`, nonce, `iat`, `exp`, actor, and ECDSA P-256 over `SHA-256(bytes 0..41)` as raw
`r || s`. Lifetime `UNLOCK_TOKEN_TTL_SECONDS` (default 120, at most 300: the box rejects longer ones).

Checked against the firmware's reference signer (`tools/unlock_token.py`, which its README validates against
the mbedtls verifier of the ESP32): for the same inputs both produce the same 42-byte body, a token signed by
the backend verifies in Python and one signed in Python verifies in the backend. Not yet run against the
mbedtls code itself or a real box.

## Pending

- Chaincode events `UNLOCK_GRANTED` / `UNLOCK_DENIED`, and flagging a `LID_OPENED` with no `UNLOCK_GRANTED`
  near it as a forced opening. Today the evidence on-chain is the 0x08 flag in the next signed reading.
- Relay attack (someone photographs the QR of a box they are not next to): mitigated only by the 120 s nonce,
  single use and BLE range. The app writes over BLE, so it has to be near the box; an RSSI threshold or a PIN on
  the e-paper would close it further.
