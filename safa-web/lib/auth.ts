// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/auth.ts
// (rename to: auth.ts)
// ==========================================================
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" }, // required when using the Credentials provider
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = String(credentials.email).trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.password) return null;
        const valid = await bcrypt.compare(credentials.password, user.password);
        if (!valid) return null;
        if (user.blocked) throw new Error("This account has been suspended. Contact support if you think this is a mistake.");
        if (!user.emailVerified) throw new Error("Please confirm your email address first. Check your inbox for the confirmation link.");
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
    ...(googleEnabled
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
            // Only link Google to an existing account when that account's email is already verified,
            // so an attacker can't pre-register someone's Gmail with a password and hijack it later.
            allowDangerousEmailAccountLinking: false,
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.uid = (user as { id: string }).id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.uid) (session.user as { id?: string }).id = token.uid as string;
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};