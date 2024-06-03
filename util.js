const fs = require('fs');
const path = require('path');
const { Queue } = require('queue-typed');
const { Writable } = require('stream');
const { Collection, SlashCommandBuilder } = require('discord.js');
const config = require('./config.js');

/**
 * @typedef TimestampedOpusPacket
 * @property {number} timestamp
 * @property {Buffer} chunk
 * @property {boolean} isStart
 */

/**
 * @return {TimestampedOpusPacket}
 */
function timestamped(chunk, isStart=false) {
    return { timestamp: Date.now(), chunk, isStart };
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
 * @typedef Command
 * @property {SlashCommandBuilder} data
 * @property {Function} execute
 */

/**
 * Loads all commands from the commands folder into the given collection.
 * @param {Collection<string, Command>} commands
 * @returns {Collection<string, Command>}
 */
function loadCommands(commands) {
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            commands.set(command.data.name, command);
        } else {
            console.warn(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
    return commands;
}

module.exports = {
    timestamped,
    ClipQueue,
    GuildInfo,
    loadCommands
};