const { SlashCommandBuilder, ChatInputCommandInteraction, CacheType, Snowflake, AttachmentBuilder } = require('discord.js');
const { GuildInfo } = require('../util.js');
const config = require('../config.js');
const { opusToPCM, pcmToWAV } = require('../audio.js');

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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clip')
        .setDescription('Clips the given user(s).')
        .addUserOption(option => option
            .setName('user')
            .setDescription('(optional) The user you want to clip.')
            .setRequired(false))
        .setDMPermission(false),
    /**
     *
     * @param {ChatInputCommandInteraction<CacheType>} interaction
     * @param {Map<Snowflake, GuildInfo>} guildMap
     * @returns
     */
    async execute(interaction, guildMap) {
        // get mentioned user's id
        const userOption = interaction.options.get('user', false);
        const user = userOption?.user;
        if (!user) {
            return await interaction.reply({ content: 'Mention a user to get the clip of them!', ephemeral: true });
        }

        const userId = user.id;
        const guildInfo = guildMap.get(interaction.guildId);

        if (!guildInfo.inChannel) {
            return await interaction.reply({ content: 'I\'m not connected to the voice channel!', ephemeral: true });
        }

        // create WAV
        const wavData = createWAV(guildInfo, userId);
        if (!wavData) {
            return await interaction.reply({ content: 'No data. Are they connected to the voice channel and speaking?', ephemeral: true });
        }

        console.debug('clip');

        // create and send message with the WAV
        return await interaction.reply({
            content: 'Here\'s your clip!',
            files: [new AttachmentBuilder(wavData, {
                name: `${user.displayName}-clip.wav`
            })]
        });
    }
};