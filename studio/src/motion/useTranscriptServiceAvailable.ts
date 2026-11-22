import { useCloudDisklessMode } from '../utils/cloudRuntime';

/** Local Studio provides transcript documents and ASR jobs. Both runtimes support native caption tracks. */
export function useTranscriptServiceAvailable(): boolean {
  return !useCloudDisklessMode();
}
