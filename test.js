/**
 * Testing opus packets to wav file creation.
 */

const config = require('./config.js');
const { readFileSync, writeFileSync } = require('fs');
const { opusToPCM, pcmToWAV } = require('./audio.js')

function fixBuffers(packets) {
    for (let x of packets) {
        if (x.chunk) {
            x.chunk = Buffer.from(x.chunk.data);
        }
    }
    return packets;
}

const duration = 5000;
const tMinus = 35000;

let testPacketsBuffer = readFileSync(config.testOpusPacketFile);
let opusPackets = fixBuffers(JSON.parse(testPacketsBuffer));
let pcmData = opusToPCM(opusPackets, duration, opusPackets[opusPackets.length - 1].timestamp - tMinus);
let wavData = pcmToWAV(pcmData);

writeFileSync('test-clip.wav', wavData);