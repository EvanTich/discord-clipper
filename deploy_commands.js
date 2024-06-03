const { Collection, REST, Routes } = require('discord.js');
const { loadCommands } = require('./util.js');
const { token } = require('./token.js');
const { botId } = require('./config.js');

const TEST = false;

const clientId = botId;
const guildId = '277674038069952523'; // test guild :)
const commands = new Collection();
loadCommands(commands);

const commandsJSON = [...commands.mapValues(command => command.data.toJSON()).values()];

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

// and deploy your commands!
(async () => {
	try {
		console.log(`Started refreshing ${commandsJSON.length} application (/) commands.`);

		// The put method is used to fully refresh all commands in the guild with the current set
		const data = await rest.put(
			TEST ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId),
			{ body: commandsJSON },
		);

		console.log(`Successfully reloaded ${data.length} application (/) commands.`);
	} catch (error) {
		// And of course, make sure you catch and log any errors!
		console.error(error);
	}
})();