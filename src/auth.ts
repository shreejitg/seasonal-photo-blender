import { googleOauth2WebProvider } from "@/auth/googleOauth2WebProvider";
import { refreshGoogleAccessToken } from "@/lib/google/refreshGoogleAccessToken";
import type { JWT } from "next-auth/jwt";
import NextAuth from "next-auth";

const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

if (!authSecret) {
  console.warn(
    "[auth] Set AUTH_SECRET (or NEXTAUTH_SECRET) in .env.local. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: authSecret,
  providers: [googleOauth2WebProvider()],
  callbacks: {
    authorized({ request, auth: a }) {
      const p = request.nextUrl.pathname;
      if (p.startsWith("/drive") || p.startsWith("/editor")) {
        return !!a;
      }
      return true;
    },
    async jwt({ token, account }): Promise<JWT> {
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at
            ? account.expires_at * 1000
            : Date.now() + 3600 * 1000,
          error: undefined,
        };
      }
      const expires = token.accessTokenExpires as number | undefined;
      const refreshT = token.refreshToken as string | undefined;
      // Refresh 2 min before expiry (or when expiry unknown but refresh exists)
      if (
        expires != null &&
        Date.now() < expires - 2 * 60 * 1000
      ) {
        return { ...token, error: undefined } as JWT;
      }
      if (refreshT) {
        try {
          const r = await refreshGoogleAccessToken(refreshT);
          return {
            ...token,
            accessToken: r.access_token,
            accessTokenExpires: Date.now() + r.expires_in * 1000,
            error: undefined,
          } as JWT;
        } catch (e) {
          console.error("[auth] Google access token refresh failed", e);
          return { ...token, error: "RefreshAccessTokenError" } as JWT;
        }
      }
      // No refresh token: keep old access token (may 401/403 on APIs when expired)
      return token;
    },
    async session({ session, token }) {
      if (token.accessToken) {
        session.accessToken = token.accessToken as string;
      }
      if (token.refreshToken) {
        session.refreshToken = token.refreshToken as string;
      }
      if (token.accessTokenExpires) {
        session.accessTokenExpires = token.accessTokenExpires as number;
      }
      if (token.error) {
        session.error = token.error;
      } else {
        session.error = undefined;
      }
      return session;
    },
  },
});
