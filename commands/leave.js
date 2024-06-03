const { SlashCommandBuilder, ChatInputCommandInteraction, CacheType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Disconnects the bot from the voice channel.')
        .setDMPermission(false),
    /**
     *
     * @param {ChatInputCommandInteraction<CacheType>} interaction
     * @returns
     */
    async execute(interaction, guildMap) {
        console.debug('leave');
        guildMap.get(interaction.guildId).disconnect();
        return await interaction.reply({ content: 'Left.', ephemeral: true });
    }
};