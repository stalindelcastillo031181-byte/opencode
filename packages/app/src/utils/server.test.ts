import { describe, expect, test } from "bun:test"
import { authCookieFromToken, authFromToken, authTokenFromCredentials } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("authCookieFromToken", () => {
  test("creates a persistent same-site cookie for an installed web app", () => {
    expect(authCookieFromToken("abc+/=", true)).toBe(
      "opencode_auth_token=abc%2B%2F%3D; Path=/; Max-Age=31536000; SameSite=Strict; Secure",
    )
  })
})
