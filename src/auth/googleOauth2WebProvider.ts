import type { OAuth2Config } from "next-auth/providers";
import type { Profile } from "next-auth";

/**
 * Google sign-in using **OAuth 2.0** (not OpenID Connect discovery). The stock
 * `Google` provider in Auth.js is `type: "oidc"`; with some setups the access token
 * does not reliably include Google API scopes (Drive, Photos Picker) even
 * when they are requested. This config uses the classic endpoints and explicit
 * `authorization.params.scope` so tokeninfo and Google APIs see the same scopes.
 * Library-wide Photos listing uses deprecated scopes; user library access uses the
 * Photos Picker API (`photospicker.mediaitems.readonly`).
 *
 * @see https://developers.google.com/identity/protocols/oauth2/web-server
 */
export function googleOauth2WebProvider(): OAuth2Config<Profile> {
  return {
    id: "google",
    name: "Google",
    type: "oauth",
    // Required so the callback can validate Google’s `iss=…` param (not https://authjs.dev).
    issuer: "https://accounts.google.com",
    checks: ["pkce", "state"],
    authorization: {
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      params: {
        response_type: "code",
        scope: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
      },
    },
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://www.googleapis.com/oauth2/v3/userinfo",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    style: { brandColor: "#1a73e8" },
  };
}
