// SPDX-License-Identifier: MIT
import { transcriptionRoute } from '@/lib/api/transcriptions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET, PATCH, DELETE } = transcriptionRoute();
export { GET, PATCH, DELETE };
