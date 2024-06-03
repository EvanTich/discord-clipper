/**
 * Main file for the discord clipper
 */

const Discord = require('discord.js');

const { token } = require('./token.js');
const config = require('./config.js');
const { GuildInfo, loadCommands } = require('./util.js');
const { joinChannel } = require('./commands/join.js');

/**
 * @type {Discord.Collection<string, import('./util.js').Command>}
 */
const commands = new Discord.Collection();
loadCommands(commands);

/**
 * Holds all guilds that have used this bot.
 * @type {Map<Discord.Snowflake, GuildInfo>}
 */
const guildMap = new Map();

function addGuildToMap(guildId) {
    if (!guildMap.get(guildId)) {
        guildMap.set(guildId, new GuildInfo(guildId));
    }
}

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
        joinChannel(channel, guildMap); // we do not care if this fails
    });
}

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.MessageContent
    ]
});

client.on(Discord.Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) {
        return;
    }
    if (!interaction.guild) {
        await interaction.reply({ content: 'Cannot use outside of servers!', ephemeral: true });
        return;
    }

    const command = commands.get(interaction.commandName);

    if (!command) {
        console.error(`Command not found: ${interaction.commandName}.`);
        return;
    }

    addGuildToMap(interaction.guildId);

    try {
        await command.execute(interaction, guildMap);
    } catch (err) {
        console.error(err);
        const errOptions = { content: 'There was an error while executing this command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errOptions);
        } else {
            await interaction.reply(errOptions);
        }
    }
});

client.on(Discord.Events.ClientReady, async client => {
    console.debug('ready');

    if (config.autoJoinEnabled) {
        setInterval(() => {
            joinChannelIf(client, config.joinChannelCondition);
        }, config.autoJoinInterval);
    }
});

client.login(token);