import { auth } from "@/auth";

export default auth;

export const config = {
  matcher: ["/drive/:path*", "/editor/:path*"],
};
