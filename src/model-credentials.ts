import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

export function encryptCredential(value: string, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authenticationTag = cipher.getAuthTag();

  return [
    VERSION,
    nonce.toString("base64url"),
    authenticationTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptCredential(value: string, secret: string): string {
  const [version, nonce, authenticationTag, encrypted] = value.split(".");

  if (version !== VERSION || !nonce || !authenticationTag || !encrypted) {
    throw new Error("Unsupported credential ciphertext");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authenticationTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function endpointFingerprint(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
}): string {
  return createHash("sha256")
    .update(input.baseUrl)
    .update("\0")
    .update(input.model)
    .update("\0")
    .update(input.apiKey)
    .digest("hex");
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256")
    .update("knowledge-model-credential\0")
    .update(secret)
    .digest();
}
