import { createHash } from "node:crypto";

export const MEANTHIS_CHROME_WEB_STORE_ID = "bbiiccaidhlhdagmabkogleldjdnmlfn";
export const MEANTHIS_CHROME_WEB_STORE_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlOFvQU9TM3aY4h5/KXGp6X6ogYIKrkqQ6FROVqxZfkPAuCcbs/qfeJ1nZUb1VDrQ4q8QlVIwHtcY3SBzdI/hTlRCaHfdHkukkIz+XPmTKsr4DVMI45eTS1DT0r7yS3ee1+ac3LL+GrG+YQl7Iw6h61DrnN1hQHnN8ayZ6lOY8W1fT9EAJeeypYhdGnjjtRJQhyKePUQG2SkWSTakU2Ya0cUEUX7W5aoJioQmtcU8twlJiMV4qF/u5yUgNgTIqJ0/bDRV6BLQiXRh0TKHDxKKwf9aGL+q2jIFYvkAz+/3oplos2Y+lcnmQ2wPI8uGhTyiu99HUp37PnDERGASxB9O7QIDAQAB";

export function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error("Extension manifest public key is invalid.");
  }
  const publicKey = Buffer.from(key, "base64");
  if (publicKey.toString("base64") !== key) {
    throw new Error("Extension manifest public key is invalid.");
  }
  const digest = createHash("sha256").update(publicKey).digest();
  const alphabet = "abcdefghijklmnop";
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [alphabet[byte >> 4], alphabet[byte & 0x0f]])
    .join("");
}

export function assertMeanThisExtensionIdentity(manifest) {
  let extensionId;
  try {
    extensionId = extensionIdFromManifestKey(manifest?.key);
  } catch {
    throw new Error("MeanThis extension identity is not pinned to the Chrome Web Store item.");
  }
  if (extensionId !== MEANTHIS_CHROME_WEB_STORE_ID) {
    throw new Error("MeanThis extension identity is not pinned to the Chrome Web Store item.");
  }
  return extensionId;
}
