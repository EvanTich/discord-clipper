/**
 * Main file for the discord clipper
 */

const { Queue } = require('queue-typed');
const Discord = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const { Transform, Writable } = require('stream');

const { token } = require('./token.js');
const config = require('./config.js');
const { opusToPCM, pcmToWAV } = require('./audio.js');

/**
 * Holds all guilds that have used this bot.
 * @type {Map<Discord.Snowflake, GuildInfo>}
 */
const guildMap = new Map();

/**
 * @typedef TimestampedOpusPacket
 * @property {number} timestamp
 * @property {Buffer} chunk
 * @property {boolean} isStart
 */
/**
 * @returns {Transform} transformer that creates and emits {@link TimestampedOpusPackets}
 */
function createTimestamper() {
    return new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
            callback(null, {timestamp: Date.now(), chunk, isStart: false});
        }
    });
}

class ClipQueue extends Writable {
    constructor(storageDuration) {
        super({ objectMode: true });
        /**
         * @type {Queue<TimestampedOpusPacket>}
         */
        this.queue = new Queue();
        this.storageDuration = storageDuration;
    }

    _write(chunk, encoding, next) {
        this.add(chunk);
        next();
    }

    /**
     * @param {TimestampedOpusPacket} data
     */
    add(data) {
        if (data == undefined || data == null) {
            return;
        }
        this.queue.push(data);
        this.truncate(data.timestamp);
    }

    /**
     * Clears the front of the queue if the timestamps are outside our storage duration bounds
     * @param {number} latestTimestamp the latest timestamp
     */
    truncate(latestTimestamp) {
        while (!this.queue.isEmpty()
                && this.queue.first.timestamp + this.storageDuration < latestTimestamp) {
            this.queue.shift();
        }
    }

    flagSpeakingStart() {
        this.add({timestamp: Date.now(), chunk: null, isStart: true});
    }

    /**
     * @returns the timestamped opus packets in the queue as an array;
     *      does NOT guarantee the packets are within the storage duration bounds
     */
    get packets() {
        return this.queue.elements;
    }
}

class GuildInfo {

    /**
     * @param {Discord.Snowflake} guildId
     */
    constructor(guildId) {
        this.guildId = guildId;
        /**
         * @type {Discord.VoiceChannel}
         */
        this.channel = null;
        this.connection = null;
        /**
         * @type {Map<Discord.Snowflake, ClipQueue>}
         */
        this.userClips = new Map();
        this.settings = {
            storageDuration: config.clipStorageDuration,
            voiceTimeout: config.voiceReceiverTimeout,
        };

        /**
         * @type {NodeJS.Timeout}
         */
        this.channelTimeout = null;
    }

    get inChannel() {
        return this.channel != null;
    }

    getUserQueue(userId) {
        let clips = this.userClips.get(userId);
        if (clips) {
            return clips;
        }

        let newClips = new ClipQueue(this.settings.storageDuration);
        this.userClips.set(userId, newClips);
        return newClips;
    }

    /**
     * Disconnects from the current voice channel, if possible.
     */
    disconnect() {
        if (!this.inChannel) {
            return;
        }

        clearInterval(this.channelTimeout);
        this.channelTimeout = null;
        this.connection.destroy();
        this.channel = null;
        this.connection = null;
    }

    /**
     * Disconnects the bot from this guild if there are no members in the voice channel.
     * Also disconnects if the bot is not in the channel (kicked by somebody else).
     */
    checkTimeout() {
        let members = this.channel?.members?.filter(m => !m.user.bot);
        if (members?.size > 0 && this.channel?.members?.find(m => m.user.id == config.botId)) {
            return;
        }

        this.disconnect();
    }

    /**
     * Starts an interval to check the timeout status of the voice connection.
     * Automatically disconnects the bot from channels with nobody in them after a configurable amount of time.
     */
    startTimeout() {
        if (this.channelTimeout) {
            return;
        }

        this.channelTimeout = setInterval(() => this.checkTimeout(), this.settings.voiceTimeout);
    }
}

/**
 * Creates WAV data from the given guild and user id if possible.
 * @param {GuildInfo} guildInfo the guild info to get the raw user PCM data from
 * @param {Discord.Snowflake} userId the user id
 * @returns {Buffer | null} WAV data if the user has any saved raw PCM data
 */
function createWAV(guildInfo, userId) {
    const start = Date.now();

    let data = guildInfo.getUserQueue(userId);
    if (!data) {
        return null;
    }

    let opusPackets = data.packets;
    if (opusPackets.length == 0) {
        return null;
    }

    // TODO: allow user to specify clip duration and t0
    let pcmData = opusToPCM(opusPackets, config.maxClipDurationMS, start - config.maxClipDurationMS);
    if (pcmData == null) {
        return null;
    }
    let wavData = pcmToWAV(pcmData);

    if (config.showAudioConversionTime) {
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
        return 'No data. Are they connected to the voice channel and speaking?';
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
    if (guildInfo.inChannel
            && guildInfo.channel.id == channel.id
            && guildInfo.channel.members.has(client.user.id)) {
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
    if (config.debuggingEnabled) {
        connection.on('debug', msg => console.log('conn debug:', msg));
        connection.on('stateChange', (o, n) => console.log(n));
        connection.state.networking?.on('debug', console.log);
        let origOnWsPacket = receiver.onWsPacket;
        receiver.onWsPacket = packet => {
            console.log(packet);
            origOnWsPacket(packet);
        }
    }

    receiver.speaking.on('start', userId => {
        let userClips = guildInfo.getUserQueue(userId);
        userClips.flagSpeakingStart();
        // FIXME: might need to lock the thread while we check/create the subscription
        // if we already have a subscription for them, stop
        if (receiver.subscriptions.has(userId)) {
            return;
        }

        // otherwise, create a new subscription and start reading opus packets
        let sub = receiver.subscribe(userId, voiceReceiverOptions);
        sub.pipe(createTimestamper())
            .pipe(userClips, { end: false });
    });

    // remember to add the info to our info object
    guildInfo.channel = channel;
    guildInfo.connection = connection;
    guildInfo.startTimeout();

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

async function help(msg) {
    return `Help: \`!clip [command]\`
- \`join\`: Join the voice channel you are currently in
- \`[mention user]\`: Create a clip of the mentioned user
- \`leave\`: Leave the voice channel`;
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
        case 'help':
            return help(msg);
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