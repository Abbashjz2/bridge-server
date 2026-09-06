BillFlow Bridge v1.0.58 - Per-Bridge credential key registration (Phase 1)

- Generates one RSA-4096 credential key pair per Bridge installation.
- Stores the private key only in the Bridge persistent configuration directory.
- Registers only the SPKI public key with BillFlow using the existing Bridge JWT.
- Reuses the same key across container restarts and image updates.
- Key registration is best-effort in this phase and cannot break the existing AES credential, terminal, or monitoring flows.
- No credential decryption behavior has changed yet.
