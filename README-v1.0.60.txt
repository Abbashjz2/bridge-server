BillFlow Bridge v1.0.60

Phase 2B: Bridge-side credential decryption

- Supports bridge-asymmetric-v1 credential payloads from redeem-terminal-session and get-bridge-device.
- Decrypts RSA-OAEP/SHA-256 ciphertext locally using the per-Bridge private key.
- Validates algorithm and credential key version before decrypting.
- Keeps asymmetric ciphertext encrypted in the device cache; plaintext is produced only for the connection context.
- Preserves legacy aes-256-gcm-shared-v1 compatibility.
- Rejects unexpected plaintext on asymmetric responses.
