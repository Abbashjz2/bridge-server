const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'rsa-oaep-sha256-4096';
const ASYMMETRIC_SCHEME = 'bridge-asymmetric-v1';


function decodeBase64Ciphertext(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('invalid_credential_ciphertext');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== 512 || buffer.toString('base64') !== value) {
    throw new Error('invalid_credential_ciphertext');
  }
  return buffer;
}

function readLocalKeyVersion(config) {
  const metaPath = path.join(config.CREDENTIAL_KEY_DIR, 'device-credentials-meta.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (_) {
    throw new Error('credential_key_metadata_unavailable');
  }
  const version = Number(meta?.key_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('credential_key_metadata_invalid');
  }
  if (meta.algorithm && meta.algorithm !== ALGORITHM) {
    throw new Error('credential_key_algorithm_mismatch');
  }
  return version;
}

function decryptBridgeCredential(config, credential) {
  if (!credential || credential.scheme !== ASYMMETRIC_SCHEME) {
    throw new Error('unsupported_credential_scheme');
  }
  if (credential.algorithm !== ALGORITHM) {
    throw new Error('unsupported_credential_algorithm');
  }
  const keyVersion = Number(credential.key_version);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error('invalid_credential_key_version');
  }
  const localVersion = readLocalKeyVersion(config);
  if (keyVersion !== localVersion) {
    throw new Error(`credential_key_version_mismatch:${keyVersion}:${localVersion}`);
  }

  const privatePath = path.join(config.CREDENTIAL_KEY_DIR, 'device-credentials-private.pem');
  let privateKey;
  try {
    privateKey = fs.readFileSync(privatePath, 'utf8');
  } catch (_) {
    throw new Error('credential_private_key_unavailable');
  }

  const ciphertext = decodeBase64Ciphertext(credential.ciphertext);
  let plaintext;
  try {
    plaintext = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      ciphertext
    );
  } catch (_) {
    throw new Error('credential_decryption_failed');
  }

  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
    ciphertext.fill(0);
  }
}

class CredentialKeyService {
  constructor({ config, getBridgeToken, fetchImpl, log }) {
    this.config = config;
    this.getBridgeToken = getBridgeToken;
    this.fetch = fetchImpl || global.fetch || require('node-fetch');
    this.log = log || (() => {});
    this.dir = config.CREDENTIAL_KEY_DIR;
    this.privatePath = path.join(this.dir, 'device-credentials-private.pem');
    this.publicPath = path.join(this.dir, 'device-credentials-public.pem');
    this.metaPath = path.join(this.dir, 'device-credentials-meta.json');
  }

  _ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch (_) {}
  }

  _writeAtomic(file, data, mode) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  }

  ensureKeyPair() {
    this._ensureDir();
    const havePrivate = fs.existsSync(this.privatePath);
    const havePublic = fs.existsSync(this.publicPath);

    if (havePrivate) {
      fs.chmodSync(this.privatePath, 0o600);
      const privateKey = fs.readFileSync(this.privatePath, 'utf8');
      const privateObj = crypto.createPrivateKey(privateKey);
      const derivedPublic = crypto.createPublicKey(privateObj).export({ type: 'spki', format: 'pem' });
      if (!havePublic || fs.readFileSync(this.publicPath, 'utf8') !== derivedPublic) {
        this._writeAtomic(this.publicPath, derivedPublic, 0o644);
      }
      return { publicKey: derivedPublic, generated: false };
    }

    if (havePublic) {
      throw new Error('credential_key_private_missing_public_present');
    }

    this.log('Generating per-Bridge RSA-4096 credential key pair...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this._writeAtomic(this.privatePath, privateKey, 0o600);
    this._writeAtomic(this.publicPath, publicKey, 0o644);
    return { publicKey, generated: true };
  }

  async register() {
    if (!this.config.CREDENTIAL_KEY_REGISTRATION_ENABLED) {
      this.log('Credential public-key registration disabled by config.');
      return { skipped: true };
    }
    const { publicKey, generated } = this.ensureKeyPair();
    const token = await this.getBridgeToken();
    const url = `${this.config.SUPABASE_FUNCTIONS_URL.replace(/\/+$/, '')}/bridge-credential-key`;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };
    if (this.config.SUPABASE_ANON_KEY) headers.apikey = this.config.SUPABASE_ANON_KEY;

    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ algorithm: ALGORITHM, public_key: publicKey }),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok || !data.credential_public_key_registered) {
      throw new Error(`credential_key_registration_failed:${response.status}:${data.error || 'unknown'}`);
    }

    const meta = {
      algorithm: data.credential_key_algorithm || ALGORITHM,
      key_version: data.credential_key_version || null,
      registered_at: data.credential_key_registered_at || new Date().toISOString(),
    };
    this._writeAtomic(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 0o600);
    this.log(`Credential public key ${generated ? 'generated and ' : ''}registered (version=${meta.key_version ?? 'unknown'}).`);
    return { ...meta, generated, rotated: Boolean(data.rotated) };
  }
}

module.exports = {
  CredentialKeyService,
  ALGORITHM,
  ASYMMETRIC_SCHEME,
  decryptBridgeCredential,
};
