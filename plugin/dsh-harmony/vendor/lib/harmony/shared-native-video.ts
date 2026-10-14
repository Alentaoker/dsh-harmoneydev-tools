import { openNativeDevEcoVideo, nativeDevEcoVideoStreaming, type NativeVideoOptions } from './deveco-native-video';
import { openSharedVideo, sharedVideoStreaming } from './shared-video';

export const sharedNativeVideoStreaming = (serial: string) => sharedVideoStreaming(serial) || nativeDevEcoVideoStreaming(serial);

export function openSharedNativeDevEcoVideo(options: NativeVideoOptions) {
  return openSharedVideo({
    serial: options.serial,
    signal: options.signal,
    // A viewer's HTTP abort never becomes the shared encoder's cancellation.
    openSource: signal => openNativeDevEcoVideo({ ...options, signal }),
  });
}
