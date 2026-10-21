// SPDX-License-Identifier: MIT
import { transcriptionAltoDownloadRoute } from '@/lib/api/transcriptions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const { GET } = transcriptionAltoDownloadRoute();
export { GET };
