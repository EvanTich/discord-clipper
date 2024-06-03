const { SlashCommandBuilder, ChatInputCommandInteraction, CacheType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Gives useless advice.')
        .setDMPermission(false),
    /**
     *
     * @param {ChatInputCommandInteraction<CacheType>} interaction
     * @returns
     */
    async execute(interaction) {
        console.debug('help');
        return await interaction.reply( {
            content: `Help:
- \`/join\`: Join the voice channel you are currently in
- \`/clip [mention]\`: Create a clip of the mentioned user
- \`/leave\`: Leave the voice channel`,
            ephemeral: true
        });
    }
};