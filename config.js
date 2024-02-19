
/**
 * @param {Discord.VoiceChannel} channel 
 * @returns {boolean}
 */
function channelHas5People(channel) {
    return channel.members.size >= 5;
}

/**
 * @param {Discord.VoiceChannel} channel 
 * @returns {boolean}
 */
function channelHasDeveloper(channel) {
    return channel.members.some(mem => mem.user.id == '203281664699269121');
}

module.exports = {
    maxClipDurationMS: 30000,
    voiceReceiverTimeout: 150000,
    prefix: '!clip',
    autoJoinInterval: 60000,
    joinChannelCondition: channelHasDeveloper,
    autoJoinEnabled: false,
    autoLeaveInterval: 150000,
}