const { VoiceChannel, SlashCommandBuilder, ChatInputCommandInteraction, CacheType } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const { Transform } = require('stream');
const { timestamped } = require('../util.js');
const config = require('../config.js');

/**
 * @returns {Transform} transformer that creates and emits TimestampedOpusPackets
 */
function createTimestamper() {
    return new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
            callback(null, timestamped(chunk));
        }
    });
}

/**
 *
 * @param {VoiceChannel} channel
 * @returns
 */
async function joinChannel(channel, guildMap) {
    if (!channel) {
        return { content: 'You\'re not connected to a voice channel!', ephemeral: true };
    }

    const guildId = channel.guildId;
    const guildInfo = guildMap.get(guildId);

    // make sure the bot isn't already in the channel
    if (guildInfo.inChannel
            && guildInfo.channel.id == channel.id
            && guildInfo.channel.members.has(channel.client.user.id)) {
        return { content: 'I\'m already connected!', ephemeral: true };
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

    return { content: 'Joined.', ephemeral: true };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Makes the bot join your voice channel to record clips.')
        .setDMPermission(false),
    /**
     *
     * @param {ChatInputCommandInteraction<CacheType>} interaction
     * @returns
     */
    async execute(interaction, guildMap) {
        const channel = interaction.member?.voice.channel;
        let response = await joinChannel(channel, guildMap);
        if (response) {
            return await interaction.reply(response);
        }
    },
    joinChannel
};