
/**
 * @param {Discord.VoiceChannel} channel 
 * @returns {boolean}
 */
function channelHas5People(channel) {
    return channel.members.size >= 5;
}

const developerId = '203281664699269121';

/**
 * @param {Discord.VoiceChannel} channel 
 * @returns {boolean}
 */
function channelHasDeveloper(channel) {
    return channel.members.some(mem => mem.user.id == developerId);
}

module.exports = {
    maxClipDurationMS: 30000,
    voiceReceiverTimeout: 150000,
    prefix: '!clip',
    autoJoinInterval: 60000,
    joinChannelCondition: channelHasDeveloper,
    autoJoinEnabled: false,
    clipStorageDuration: 90000, // 1.5 minutes
    testOpusPacketFile: 'test_opus_packets.json',
    botId: '1206806233957408770',
    developerId: developerId
}