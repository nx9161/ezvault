// SPDX-License-Identifier: MIT
import { photoTranscriptionsRoute } from '@/lib/api/transcriptions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET, POST } = photoTranscriptionsRoute();
export { GET, POST };
