/**
 * Discord clipper:
 * 1. join voice channel in guild
 * 2. create voice stream for each user (incl. when new users join)
 *    x raw pcm
 * 3. on data for user voice stream:
 *    - store in queue and remove the front of the queue when the length is too long
 *    - can check # of samples to compute time
 * 4. when user asks for clip
 *    - create WAV from raw pcm in queue
 *    - notify the recording length and if it was outside a certain bound
 *    ? store WAV as file "{user}-{time}.wav"
 *    - send to user in channel
 *
 * TODO: register and use slash commands (https://discordjs.guide/creating-your-bot/slash-commands.html)
 * TODO: per user settings
 * TODO: per server settings
 * TODO: circular buffer for storing clip queue
 * TODO: clip command with duration
 * TODO: store more audio, allow clipping from any point
 * TODO (QA): allow a clip w/ everybody
 * TODO: backend database for storing guild settings
 * FIXME (QA): should say something about summoning him before trying to clip a member
 * FIXME (QA): add help command
 * FIXME (QA): distortions in audio (this may be due to the async on the receiver's speaking map) NEED TO TEST
 * TODO (QA): add silence
 * TODO (QA): make bot leave if nobody is in the chat 
 */

const { Queue } = require('queue-typed');
const Discord = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');

const { token } = require('./token.js');
const config = require('./config.js');

const SHOW_CONVERSION_TIME = false;
const SHOW_PACKETS = false;

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
const MAX_CLIP_SIZE = config.maxClipDurationMS * BYTES_PER_MS;

const OPUS = new OpusEncoder(48000, 2);

/**
 * Holds all guilds that have used this bot.
 * @type {Map<Discord.Snowflake, GuildInfo>}
 */
const guildMap = new Map();

/**
 * @param {Buffer} wavData wav data buffer
 * @returns {number} WAV duration
 */
function getWAVDuration(wavData) {
    return (wavData.length - HEADER_LENGTH) / BYTES_PER_MS;
}

// TODO: circlular array with however many samples * 4 we're expecting
//  i.e. 60 seconds * 48_000 samples/s * 4 bytes/sample = 11_520_000 bytes/minute interval
//   only 12 MB per minute per person in memory if working at the array level which isn't bad at all
class ClipQueue {
    constructor(maxLength) {
        this.queue = new Queue();
        this.length = 0;
        this.maxLength = maxLength;
    }

    /**
     * @param {ClipPart} clip the clip part to add
     */
    add(clip) {
        this.queue.push(clip);
        this.length += clip.length;
        if (this.length > this.maxLength) {
            void this.remove();
        }
    }

    remove() {
        const clip = this.queue.shift();
        this.length -= clip.length;
        return clip;
    }

    /**
     * @returns the collected PCM data of all the clip parts in this queue
     */
    toPCM() {
        return Buffer.concat(this.queue.elements);
    }

    get isEmpty() {
        return this.length === 0;
    }
}

class GuildInfo {

    /**
     * @param {Discord.Snowflake} guildId
     */
    constructor(guildId) {
        this.guildId = guildId;
        /**
         * @type {Discord.Channel}
         */
        this.channel = null;
        this.connection = null;
        /**
         * @type {Map<Discord.Snowflake, ClipQueue>}
         */
        this.userClips = new Map();
        this.settings = {
            maxClipSize: MAX_CLIP_SIZE
        };

        /**
         * @type {NodeJS.Timeout}
         */
        this.channelTimeout = null;
    }

    get inChannel() {
        return this.channel != null;
    }

    addUser(userId) {
        let clips = this.userClips.get(userId);
        if (clips) {
            return clips;
        }

        let newClips = new ClipQueue(this.settings.maxClipSize);
        this.userClips.set(userId, newClips);
        return newClips;
    }

    disconnect() {
        if (this.inChannel) {
            this.connection.destroy();
            this.channel = null;
            this.connection = null;
            return true;
        }
        return false;
    }

    updateTimeout() {
        clearTimeout(this.channelTimeout);
        this.channelTimeout = setTimeout(this.disconnect, config.voiceReceiverTimeout);
    }
}

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

/**
 * Creates WAV data from the given guild and user id if possible.
 * @param {GuildInfo} guildInfo the guild info to get the raw user PCM data from
 * @param {Discord.Snowflake} userId the user id
 * @returns {Buffer | null} WAV data if the user has any saved raw PCM data
 */
function createWAV(guildInfo, userId) {
    const start = Date.now();

    let data = guildInfo.userClips.get(userId);
    if (!data) {
        return null;
    }
    let rawPCM = data.toPCM();
    let wavData = pcmToWAV(rawPCM);
    
    if (SHOW_CONVERSION_TIME) {
        console.debug('time taken: ', (Date.now() - start));
    }

    return wavData;
}

/**
 * @param {Discord.Message<true>} msg 
 * @returns {Promise<string | false | Discord.MessageCreateOptions>}
 */
async function sendClip(msg) {
    // get mentioned user's id
    const user = msg.mentions.members.first();
    if (!user) {
        return 'Mention a user to get the clip of them!';
    }

    const userId = user.id;
    const guildInfo = guildMap.get(msg.guildId);

    // create WAV
    const wavData = createWAV(guildInfo, userId);
    if (!wavData) {
        return false;
    }

    console.debug('clip');

    // create and send message with the WAV
    return {
        content: 'Here\'s your clip!',
        files: [new Discord.AttachmentBuilder(wavData, {
            name: `${user.displayName}-clip.wav`
        })]
    };
}

/**
 * 
 * @param {Discord.VoiceChannel} channel 
 * @returns {Promise<string | false>}
 */
async function joinChannel(channel) {
    if (!channel) {
        return 'You\'re not connected to a voice channel!';
    }

    const guildId = channel.guildId;
    const guildInfo = guildMap.get(guildId);

    // make sure the bot isn't already in the channel
    if (guildInfo.inChannel && guildInfo.channel.id == channel.id) {
        return 'I\'m already connected!';
    }

    console.debug('join');

    // setup our connection
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
	    adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false
    });

    // setup the receiver options to automatically close after timeout
    const voiceReceiverOptions = {
        end: { 
            behavior: EndBehaviorType.AfterInactivity, 
            duration: config.voiceReceiverTimeout 
        }
    };

    // when people start talking
    const receiver = connection.receiver;
    receiver.speaking.on('start', userId => {
        // if we already have a subscription for them, stop
        if (receiver.subscriptions.has(userId)) {
            return;
        }
        let sub = receiver.subscribe(userId, voiceReceiverOptions);
        let userClips = guildInfo.addUser(userId);

        // otherwise, create a new subscription and start reading opus packets
        sub.on('data', opusPacket => {
            let data = OPUS.decode(opusPacket);
            userClips.add(data);

            if (SHOW_PACKETS) {
                console.debug('encoded:', opusPacket);
                console.debug('decoded:', data);
            }
        });
    });

    // guildInfo.channelTimeout = setTimeout()

    // remember to add the info to our info object
    guildInfo.channel = channel;
    guildInfo.connection = connection;

    return false;
}

/**
 * @param {Discord.Message<true>} msg 
 * @returns {Promise<string | false>}
 */
async function join(msg) {
    const channel = msg.member.voice.channel;
    if (!channel) {
        return false;
    }

    return await joinChannel(channel);
}

/**
 * @param {Discord.Message<true>} msg 
 * @returns {Promise<false>}
 */
async function leave(msg) {
    console.debug('leave');
    guildMap.get(msg.guildId).disconnect();
    return false;
}

function addGuildToMap(guildId) {
    if (!guildMap.get(guildId)) {
        guildMap.set(guildId, new GuildInfo(guildId));
    }
}

/**
 * Parses the message for any commands and returns the result of the command if possible.
 * @param {Discord.Message<true>} msg 
 * @returns {Promise<string | false | Discord.MessageCreateOptions>}
 */
async function parseMessage(msg) {
    let [, command, ...args] = msg.content.split(' ');
    switch (command) {
        case 'leave':
            return leave(msg);
        case 'join':
            return join(msg);
        default:
            return sendClip(msg);
    }
}

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.MessageContent
    ]
});

client.on(Discord.Events.MessageCreate, async msg => {
    if (msg.author.system
        || msg.author.bot
        || !msg.content.startsWith(config.prefix)) {
        return;
    }
    if (!msg.guild) {
        msg.channel.send('Cannot use outside of servers!');
        return;
    }

    // make sure to put this guild in the guild map!
    addGuildToMap(msg.guildId);
    let response = await parseMessage(msg);
    if (response) {
        msg.channel.send(response);
    }
});

/**
 * @param {Discord.Client} client 
 * @param {Function<Discord.Channel, boolean>} condition 
 */
function joinChannelIf(client, condition) {
    client.guilds.cache.forEach(guild => {
        let channel = guild.channels.cache
            .find(c => channel.type === Discord.ChannelType.GuildVoice && condition(c));

        // make sure to put this guild in the guild map!
        addGuildToMap(msg.guildId);
        joinChannel(channel); // we do not care if this fails
    });
}

// TODO: client.on(Discord.Events.InteractionCreate)

client.on(Discord.Events.ClientReady, async client => {
    console.debug('ready');

    if (config.autoJoinEnabled) {
        setInterval(() => {
            joinChannelIf(client, config.joinChannelCondition);
        }, config.autoJoinInterval);
    }
});

client.login(token);