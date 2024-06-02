# Discord Clipper
A Discord bot that can record users' voices. 
[Here](https://discord.com/api/oauth2/authorize?client_id=1206806233957408770&permissions=274878991360&scope=bot%20applications.commands) is a join link.

## How It's Done
1. Join a voice channel in a Discord server.
2. Create voice stream for each user (incl. when new users join).
3. When we get data (an OPUS packet) from the users' voice stream:
   - Timestamp the packet when we get it
   - Store in users' "clip queue"
   - Truncate the old packets from the clip queue
4. When a user asks for clip:
   - Convert the OPUS to raw PCM while keeping track of the start and end timestamps
   - Allocate a buffer to store PCM
   - Place the raw PCM in the correct place in the buffer using the starting timestamp
   - Add WAV headers to the raw PCM to create a WAV file in-memory
   - Send the WAV file to the user

## Problems
- Crackly audio


## TODO
- TODO: register and use slash commands (https://discordjs.guide/creating-your-bot/slash-commands.html)
- TODO: per user settings
- TODO: per server settings
- TODO: circular buffer for storing clip queue
- TODO: clip command with duration
- TODO: store more audio, allow clipping from any point
- TODO (QA): allow a clip w/ everybody
- TODO: backend database for storing guild settings
- FIXME (QA): should say something about summoning him before trying to clip a member
- ~~FIXME (QA): add help command~~
- ~~FIXME (QA): distortions in audio (this may be due to the async on the receiver's speaking map)~~
- ~~TODO (QA): add silence~~
- ~~TODO (QA): make bot leave if nobody is in the chat~~
- TODO: special audio clip when people mention the bot for clipping
- TODO: move functions out to separate files (~~audio.js~~, commands/*.js)
    - need to adjust how data is moved around