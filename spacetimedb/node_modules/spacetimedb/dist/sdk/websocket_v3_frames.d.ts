import BinaryReader from '../lib/binary_reader.ts';
import BinaryWriter from '../lib/binary_writer.ts';
import { ServerMessage } from './client_api/types';
export declare function countClientMessagesForV3Frame(messages: readonly Uint8Array<ArrayBuffer>[], maxFrameBytes: number): number;
export declare function encodeClientMessagesV3(writer: BinaryWriter, messages: readonly Uint8Array<ArrayBuffer>[], messageCount?: number): Uint8Array<ArrayBuffer>;
export declare function decodeClientMessagesV3(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[];
export declare function encodeServerMessagesV3(writer: BinaryWriter, messages: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer>;
export declare function forEachServerMessageV3(reader: BinaryReader, data: Uint8Array, visit: (message: ServerMessage) => void): number;
//# sourceMappingURL=websocket_v3_frames.d.ts.map