const { SlashCommandBuilder, ChatInputCommandInteraction, CacheType, Snowflake, AttachmentBuilder, VoiceChannel } = require('discord.js');
const { writeFile } = require('fs');

const { GuildInfo } = require('../util.js');
const config = require('../config.js');
const { opusToPCM, pcmToWAV } = require('../audio.js');

const USER_OPTION = 'user';
const DURATION_OPTION = 'duration';
const T_MINUS_OPTION = 't-minus';

/**
 * Creates WAV data from the given guild and user id if possible.
 * @param {GuildInfo} guildInfo the guild info to get the raw user PCM data from
 * @param {Snowflake[]} userIds the user id
 * @param {number} duration the duration of the clip
 * @param {number} tMinus how many seconds ago you want to start the clip from
 * @returns {Buffer | null} WAV data if the user has any saved raw PCM data
 */
function createWAV(guildInfo, userIds, duration, tMinus) {
    const start = Date.now();
    if (userIds.length === 0) {
        return null;
    }

    let userClips = userIds.map(id => guildInfo.getUserQueue(id));
    let opusPackets = userClips.flatMap(clips => clips.packets);
    if (opusPackets.length === 0) {
        return null;
    }

    if (config.writeTestPackets) {
        writeFile(config.testOpusPacketFile, JSON.stringify(opusPackets), err => {
            if (err) {
                console.error(err);
            }
        });
    }

    let pcmData = opusToPCM(opusPackets, duration, start - tMinus);
    if (pcmData === null) {
        return null;
    }
    let wavData = pcmToWAV(pcmData);

    if (config.showAudioConversionTime) {
        console.debug('time taken: ', (Date.now() - start));
    }

    return wavData;
}

/**
 * Parses the ids needed for the clip. Handles mentioning a user, a role, or none at all.
 * @param {ChatInputCommandInteraction<CacheType>} interaction the interaction
 * @param {VoiceChannel} voiceChannel the voice channel the bot is in
 * @returns {{ ids: Snowflake[], name: string}} list of user ids to clip
 */
function parseIds(interaction, voiceChannel) {
    const userOption = interaction.options.get(USER_OPTION, false);

    let ids = [];
    let name;
    if (userOption?.user) {
        // single user
        ids.push(userOption.user.id);
        name = `${voiceChannel.name}-${userOption.user.displayName}`;
    } else if (userOption?.role) {
        // all users with role
        voiceChannel.members
            .filter(member => member.roles.cache.some(role => role.name === userOption.role.name))
            .forEach(member => ids.push(member.user.id));
        name = `${voiceChannel.name}-${userOption.role.name}`;
    } else {
        // all users
        voiceChannel.members
            .forEach(member => ids.push(member.user.id));
        name = voiceChannel.name;
    }

    return { ids, name };
}

/**
 * Parses the duration option.
 * @param {ChatInputCommandInteraction<CacheType>} interaction the interaction
 * @returns {number}
 */
function parseDurationOption(interaction) {
    const durationOption = interaction.options.get(DURATION_OPTION, false);
    return durationOption ? Math.floor(durationOption.value * 1000) : config.maxClipDurationMS;
}

/**
 * Parses the t-minus option.
 * @param {ChatInputCommandInteraction<CacheType>} interaction the interaction
 * @param {number} duration the duration of the clip
 * @returns {number}
 */
function parseTMinusOption(interaction, duration) {
    const tMinusOption = interaction.options.get(T_MINUS_OPTION, false);
    return tMinusOption ? Math.floor(tMinusOption.value * 1000) : duration;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clip')
        .setDescription('Clips the given user(s).')
        .addMentionableOption(option => option
            .setName(USER_OPTION)
            .setDescription('The user or role you want to clip, if any.')
            .setRequired(false))
        .addNumberOption(option => option
            .setName(DURATION_OPTION)
            .setDescription(`The duration of the clip. Default: ${(config.maxClipDurationMS / 1000).toFixed(2)} seconds`)
            .setRequired(false))
        .addNumberOption(option => option
            .setName(T_MINUS_OPTION)
            .setDescription('How many seconds ago you want to start the clip from. Defaults to current duration.')
            .setRequired(false))
        .setDMPermission(false),
    /**
     * Clips the current voice channel if the bot is connected to one. Sends the WAV file in the chat if it exists.
     * @param {ChatInputCommandInteraction<CacheType>} interaction the interaction
     * @param {Map<Snowflake, GuildInfo>} guildMap the guild map
     * @returns the reply
     */
    async execute(interaction, guildMap) {
        const guildInfo = guildMap.get(interaction.guildId);
        if (!guildInfo?.inChannel) {
            return await interaction.reply({ content: 'I\'m not connected to the voice channel!', ephemeral: true });
        }

        const { ids, name } = parseIds(interaction, guildInfo.channel);
        const duration = parseDurationOption(interaction);
        const tMinus = parseTMinusOption(interaction, duration);

        // create WAV
        const wavData = createWAV(guildInfo, ids, duration, tMinus);
        if (!wavData) {
            return await interaction.reply({ content: 'No data. Are they connected to the voice channel and speaking?', ephemeral: true });
        }

        console.debug('clip', duration, tMinus);

        // create and send message with the WAV
        return await interaction.reply({
            content: 'Here\'s your clip!',
            files: [new AttachmentBuilder(wavData, {
                name: `${name}-clip.wav`
            })]
        });
    }
};