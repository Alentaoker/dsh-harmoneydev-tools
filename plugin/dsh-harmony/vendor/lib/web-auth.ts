import { createHash, timingSafeEqual } from "node:crypto";

export const PI_WEB_AUTH_USERNAME = "pi";
export const PI_DESKTOP_TOKEN_HEADER = "x-pi-desktop-token";

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.PI_WEB_PASSWORD,
): password is string {
  return typeof password === "string" && password.length > 0;
}

export function isDesktopTokenEnabled(
  token: string | undefined = process.env.PI_DESKTOP_TOKEN,
): token is string {
  return typeof token === "string" && token.length > 0;
}

export function isValidDesktopToken(
  suppliedToken: string | null,
  expectedToken = process.env.PI_DESKTOP_TOKEN,
): boolean {
  return isDesktopTokenEnabled(expectedToken)
    && typeof suppliedToken === "string"
    && secretsEqual(suppliedToken, expectedToken);
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.PI_WEB_PASSWORD,
): boolean {
  if (!isWebPasswordEnabled(password) || !authorization) return false;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return false;

  const username = credentials.slice(0, separator);
  const suppliedPassword = credentials.slice(separator + 1);
  const usernameMatches = secretsEqual(username, PI_WEB_AUTH_USERNAME);
  const passwordMatches = secretsEqual(suppliedPassword, password);
  return usernameMatches && passwordMatches;
}
