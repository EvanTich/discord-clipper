const { OpusEncoder } = require('@discordjs/opus');

/**
 * Contains main header for RIFF WAVE files.
 * PCM audio, 48k audio sampling frequency, 2 audio channels
 * http://soundfile.sapp.org/doc/WaveFormat/ is helpful for understanding it.
 * @property {Buffer} TOP    bytes for 'RIFF', ChunkSize goes afterwards
 * @property {Buffer} MIDDLE bytes for rest of WAVE format, Subchunk2Size goes afterwards
 */
const HEADERS = {
    TOP: Buffer.from([
        0x52, 0x49, 0x46, 0x46  // 'RIFF'
    ]),
    MIDDLE: Buffer.from([
        0x57, 0x41, 0x56, 0x45, // 'WAVE'
        0x66, 0x6D, 0x74, 0x20, // 'fmt '
        0x10, 0x00, 0x00, 0x00, // 16 for PCM
        0x01, 0x00,             // PCM = 1
        0x02, 0x00,             // Stereo = 2
        0x80, 0xBB, 0x00, 0x00, // sample rate
        0x00, 0xEE, 0x02, 0x00, // byte rate
        0x04, 0x00,             // block align
        0x10, 0x00,             // bits per sample = 16 bits
        0x64, 0x61, 0x74, 0x61  // 'data'
    ])
};
const HEADER_LENGTH = HEADERS.TOP.length + HEADERS.MIDDLE.length;
const HEADER_LENGTH_LESS = HEADER_LENGTH - 8; // size of file not including the chunk ID and chunk size
const BYTES_PER_MS = 192; // 192 = sampling rate (48k) * bytes in a sample (4)

const OPUS = new OpusEncoder(48000, 2);

/**
 * Creates a buffer with a 32-bit little-endian number written inside.
 * @param {number} size the number to write in the buffer
 * @returns {Buffer} a buffer with a 32-bit little-endian number written inside
 */
function sizeBuffer(size) {
    let buf = Buffer.alloc(4);
    buf.writeUInt32LE(size);
    return buf;
}

/**
 * Creates WAV data from the given raw PCM data.
 * @param {Buffer} rawPCM the raw PCM data for this WAV
 * @returns the buffer with the WAV data
 */
function pcmToWAV(rawPCM) {
    return Buffer.concat([
        HEADERS.TOP,
        sizeBuffer(HEADER_LENGTH_LESS + rawPCM.length),
        HEADERS.MIDDLE,
        sizeBuffer(rawPCM.length),
        Buffer.from(rawPCM)
    ]);
}

function mix16(a, b) {
    if (b == 0) {
        return a;
    }
    return Math.floor((a + b) / 2);
}

/**
 * Converts any OPUS packets within the clip duration, starting from t0, to PCM data.
 * @param {TimestampedOpusPacket[]} opusPackets
 * @param {number} duration
 * @param {number} t0 the start of the clip
 */
function opusToPCM(opusPackets, duration, t0) {
    // decode the opus packets within the duration to pcm (not exactly accurate, but good enough)
    const pcmPackets = [];
    let currentPCM = null; // {timestampStart, chunks}
    let firstTimestamp = t0;
    let lastTimestamp = t0;
    for (let packet of opusPackets) {
        if (packet.timestamp < t0 || packet.timestamp > t0 + duration) {
            continue;
        }

        if (packet.isStart || currentPCM === null) {
            if (currentPCM !== null) {
                pcmPackets.push(currentPCM);
            }
            firstTimestamp = Math.min(firstTimestamp, packet.timestamp);
            lastTimestamp = Math.max(lastTimestamp, packet.timestamp);
            currentPCM = {
                timestampStart: packet.timestamp,
                chunks: []
            };
            continue;
        }

        let chunk = OPUS.decode(packet.chunk);
        currentPCM.chunks.push(chunk);
        firstTimestamp = Math.min(firstTimestamp, packet.timestamp - chunk.length / BYTES_PER_MS);
        lastTimestamp = Math.max(lastTimestamp, packet.timestamp);
    }
    if (currentPCM !== null) {
        pcmPackets.push(currentPCM);
    }

    if (pcmPackets.length == 0) {
        return null;
    }

    // sanity check
    // return pcmPackets.map(v => v.chunks).reduce((a, b) => Buffer.concat([a, ...b]), Buffer.alloc(0));

    // create buffer from first and last timestamp instead of straight from the given duration
    let data = Buffer.alloc(Math.floor((lastTimestamp - firstTimestamp) * BYTES_PER_MS / 4) * 4);

    /*+---------------+---------------+-- - - --+---------------+
      |   SAMPLE 00   |   SAMPLE 01   |         |   SAMPLE  N   |
      +---+---+---+---+---+---+---+---+-- - - --+---+---+---+---+
      | L | L | R | R | L | L | R | R |         | L | L | R | R |
      +---+---+---+---+---+---+---+---+-- - - --+---+---+---+---+*/

    // put the packets where they need to be in the data array
    for (let i = 0; i < pcmPackets.length; i++) {
        let packet = pcmPackets[i];

        const pcm = Buffer.concat(packet.chunks);
        const timestamp = packet.timestampStart;

        // align our data with the samples in the data buffer
        const sampleNumber = Math.floor(Math.ceil((timestamp - firstTimestamp) * BYTES_PER_MS) / 4);
        const dataAlign = sampleNumber * 4;

        // write each channel sample separately until there are no more
        // see: L0 -> R0 -> L1 -> R1 -> ...
        let pcmOffset = 0;
        while (pcmOffset < pcm.length && dataAlign + pcmOffset < data.length - 1) {
            let num = pcm.readInt16LE(pcmOffset);
            let dataNum = data.readInt16LE(dataAlign + pcmOffset);
            data.writeInt16LE(mix16(num, dataNum), dataAlign + pcmOffset);
            pcmOffset += 2;
        }
    }

    return data;
}

/**
 * @param {Buffer} wavData wav data buffer
 * @returns {number} WAV duration in milliseconds
 */
function getWAVDuration(wavData) {
    return (wavData.length - HEADER_LENGTH) / BYTES_PER_MS;
}

module.exports = {
    opusToPCM,
    pcmToWAV,
    getWAVDuration,
    BYTES_PER_MS,
}