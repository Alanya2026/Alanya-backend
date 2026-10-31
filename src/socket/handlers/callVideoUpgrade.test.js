const assert = require('assert');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callVideoUpgrade } = require('./calls');
const { deviceRoom } = require('../../utils/deviceId');

function fakeSocket(userId, deviceId) {
  const handlers = {};
  const emitted = [];
  return {
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    async trigger(event, data, acknowledge) {
      await handlers[event](data, acknowledge);
    },
    emitted,
  };
}

function fakeIo() {
  const roomEmits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return {
        emit(event, payload) {
          roomEmits.push({ room, event, payload });
        },
      };
    },
    roomEmits,
  };
}

async function reset() {
  await Promise.all([callState.clear(10), callState.clear(77)]);
  await callDeviceOwnership.release('1329');
}

async function setCall() {
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  await callDeviceOwnership.setActive('1329', 10, {
    activeDeviceId: 'dev_10',
    activeSocketId: 's10',
  });
  await callDeviceOwnership.setActive('1329', 77, {
    activeDeviceId: 'dev_77',
    activeSocketId: 's77',
  });
}

async function main() {
  const userSockets = new Map();
  const description = { sdp: 'v=0', type: 'offer' };

  await reset();
  await setCall();
  const io = fakeIo();
  const owner = fakeSocket(10, 'dev_10');
  callVideoUpgrade(io, owner, userSockets);
  await owner.trigger('call_video_upgrade_offer', {
    targetUserId: 77,
    callId: '1329',
    transitionId: 'transition-001',
    offer: description,
  });
  const forwarded = io.roomEmits[0];
  assert.strictEqual(forwarded.event, 'call_video_upgrade_offer');
  assert.strictEqual(forwarded.room, deviceRoom(77, 'dev_77'));
  assert.strictEqual(forwarded.payload.transitionId, 'transition-001');

  await reset();
  await setCall();
  const io2 = fakeIo();
  const secondary = fakeSocket(10, 'other-device');
  callVideoUpgrade(io2, secondary, userSockets);
  await secondary.trigger('call_video_upgrade_offer', {
    targetUserId: 77,
    callId: '1329',
    transitionId: 'transition-002',
    offer: description,
  });
  assert.strictEqual(io2.roomEmits.length, 0, 'un appareil secondaire ne relaie pas');

  await reset();
  await setCall();
  const io3 = fakeIo();
  const stale = fakeSocket(10, 'dev_10');
  callVideoUpgrade(io3, stale, userSockets);
  await stale.trigger('call_video_upgrade_offer', {
    targetUserId: 77,
    callId: 'wrong-call',
    transitionId: 'transition-003',
    offer: description,
  });
  assert.strictEqual(io3.roomEmits.length, 0, 'un callId périmé est rejeté');
  assert.strictEqual(stale.emitted[0].payload.code, 'CALL_VIDEO_UPGRADE_INVALID');

  await reset();
  await setCall();
  const io4 = fakeIo();
  const commitOwner = fakeSocket(10, 'dev_10');
  callVideoUpgrade(io4, commitOwner, userSockets);
  let commitAck;
  await commitOwner.trigger(
    'call_video_upgrade_commit',
    {
      targetUserId: 77,
      callId: '1329',
      transitionId: 'transition-004',
    },
    (payload) => {
      commitAck = payload;
    },
  );
  assert.deepStrictEqual(commitAck, { ok: true });
  assert.strictEqual(io4.roomEmits[0].event, 'call_video_upgrade_commit');

  await reset();
  console.log('callVideoUpgrade.test.js OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
