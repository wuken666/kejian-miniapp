const assert = require('assert').strict

const {
  PCM_BYTES_PER_SECOND,
  calculateElapsedSeconds,
  durationFromPcmBytes,
  hasIncompleteAudio,
  nextSequenceNumber,
  transcriptFromSession
} = require('../utils/recording-state')

const cases = [
  ['按 PCM 字节数计算片段时长', () => {
    assert.equal(durationFromPcmBytes(PCM_BYTES_PER_SECOND * 30), 30)
    assert.equal(durationFromPcmBytes(1), 1)
  }],
  ['恢复课堂后从最大分片序号继续', () => {
    assert.equal(nextSequenceNumber({
      segments: [{ sequenceNumber: 2 }, { sequenceNumber: 7 }, { sequenceNumber: 3 }]
    }), 8)
    assert.equal(nextSequenceNumber(null), 0)
  }],
  ['只拼接有效的服务端转写', () => {
    assert.equal(transcriptFromSession({
      segments: [{ transcript: '第一句' }, { transcript: '  ' }, { transcript: '第二句' }]
    }), '第一句\n第二句')
  }],
  ['切后台后按绝对时间恢复计时', () => {
    assert.equal(calculateElapsedSeconds({
      status: 'recording',
      baseSeconds: 90,
      clockStartedAt: 1_000
    }, 12_999), 101)
  }],
  ['暂停状态不会继续增长', () => {
    assert.equal(calculateElapsedSeconds({
      status: 'paused',
      baseSeconds: 125,
      clockStartedAt: 1_000
    }, 90_000), 125)
  }],
  ['结束前识别缺失时长和分片断档', () => {
    assert.equal(hasIncompleteAudio({
      capturedSeconds: 30,
      clientCapturedSeconds: 120,
      segments: [{ sequenceNumber: 0 }]
    }, 120), true)
    assert.equal(hasIncompleteAudio({
      capturedSeconds: 60,
      clientCapturedSeconds: 60,
      segments: [{ sequenceNumber: 0 }, { sequenceNumber: 1 }]
    }, 60), false)
    assert.equal(hasIncompleteAudio({
      capturedSeconds: 60,
      clientCapturedSeconds: 60,
      segments: [{ sequenceNumber: 0 }, { sequenceNumber: 2 }]
    }, 60), true)
  }]
]

// 使用兼容旧版 Node 的最小测试执行器，方便本机直接验证。
cases.forEach(([name, run]) => {
  run()
  console.log(`PASS ${name}`)
})
