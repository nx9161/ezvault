// SPDX-License-Identifier: MIT
// Project workspace route. Thin server wrapper (Next 16: params is a Promise).
//
// Architecture §9 specified a server-side parallel bootstrap here, but the
// Vercel Authentication edge gate challenges server-to-self fetch (no auth
// cookie inside the function), while the browser session passes naturally.
// Frontend verdict (Phase 4): bootstrap client-side via SWR with the design's
// skeleton states, so the app works behind the gate. No Server Actions.

import WorkspaceClient from "@/components/workspace/WorkspaceClient";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <WorkspaceClient projectId={projectId} />;
}
