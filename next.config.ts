// SPDX-License-Identifier: MIT
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // cacheComponents/PPR intentionally OFF: this is a private single-user
  // workspace — every route is dynamic (Vercel Authentication at the edge,
  // all data via browser API calls). Enabling it breaks `export const
  // runtime = 'nodejs'` / `dynamic` segment configs across app/api/**.
};

export default withNextIntl(nextConfig);
