/* eslint-disable no-console */

'use strict';

const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain)
{
	if (request === 'homey')
	{
		return {
			Device: class DeviceStub
			{},
			SimpleClass: class SimpleClassStub
			{},
		};
	}

	return originalModuleLoad.call(this, request, parent, isMain);
};

const YoLinkAPI = require('../yoLinkAPI');
const GarageDoorDevice = require('../drivers/garage_door/device');
const DoorSensorDevice = require('../drivers/door-sensor/device');

Module._load = originalModuleLoad;

function createMockApp(initialUAIDList)
{
	const settingsStore = {
		UAIDList: Array.isArray(initialUAIDList) ? initialUAIDList : [],
	};

	return {
		homeyID: 'harness-homey',
		updateLog: () =>
		{},
		varToString: (value) =>
		{
			try
			{
				return JSON.stringify(value);
			}
			catch (error)
			{
				return String(value);
			}
		},
		homey: {
			settings: {
				get: (key) => settingsStore[key],
				set: (key, value) =>
				{
					settingsStore[key] = value;
				},
			},
			drivers: {
				getDrivers: () => ({}),
			},
		},
	};
}

function sleep(ms)
{
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message)
{
	if (!condition)
	{
		throw new Error(message);
	}
}

async function runTest(name, fn)
{
	try
	{
		await fn();
		console.log('PASS:', name);
		return { name, ok: true };
	}
	catch (error)
	{
		console.error('FAIL:', name);
		console.error(error.message);
		return { name, ok: false, error };
	}
}

async function testServiceZoneNormalization()
{
	const api = new YoLinkAPI(createMockApp([]));
	assert(api.getServiceZoneID('EU') === 'eu', 'Expected uppercase zone to normalize to eu');
	assert(api.getServiceZoneID('us-west') === 'us', 'Expected us-west to map to us');
	assert(api.getServiceZoneID(null) === 'us', 'Expected null zone to fallback to us');
}

async function testTokenURLByZone()
{
	const api = new YoLinkAPI(createMockApp([]));
	assert(api.getTokenURL('eu').indexOf('api-eu.yosmart.com') >= 0, 'Expected EU token URL for eu zone');
	assert(api.getTokenURL('us').indexOf('api.yosmart.com') >= 0, 'Expected US token URL for us zone');
}

async function testSameUaidRefreshIsDeduped()
{
	const now = Date.now();
	const api = new YoLinkAPI(createMockApp([
		{
			UAID: 'UAID_A',
			access_token: 'expired',
			refresh_token: 'refresh_a',
			expires_at: now - 1000,
		},
	]));

	let refreshCalls = 0;
	api.obtainAccessTokenWithRefreshToken = async () =>
	{
		refreshCalls += 1;
		await sleep(50);
		return {
			access_token: 'new_token_a',
			refresh_token: 'new_refresh_a',
			expires_in: 3600,
		};
	};

	const results = await Promise.all([
		api.getAccessTokenForUAID('UAID_A', null, 'us'),
		api.getAccessTokenForUAID('UAID_A', null, 'us'),
	]);

	assert(refreshCalls === 1, `Expected one refresh call, got ${refreshCalls}`);
	assert(results[0] === 'new_token_a' && results[1] === 'new_token_a', 'Expected both calls to return refreshed token');
}

async function testDifferentUaidRefreshCanRunConcurrently()
{
	const now = Date.now();
	const api = new YoLinkAPI(createMockApp([
		{
			UAID: 'UAID_A',
			access_token: 'expired_a',
			refresh_token: 'refresh_a',
			expires_at: now - 1000,
		},
		{
			UAID: 'UAID_B',
			access_token: 'expired_b',
			refresh_token: 'refresh_b',
			expires_at: now - 1000,
		},
	]));

	const calls = {};
	api.obtainAccessTokenWithRefreshToken = async (UAID) =>
	{
		calls[UAID] = (calls[UAID] || 0) + 1;
		await sleep(60);
		return {
			access_token: `token_${UAID}`,
			refresh_token: `refresh_${UAID}`,
			expires_in: 3600,
		};
	};

	const startedAt = Date.now();
	await Promise.all([
		api.getAccessTokenForUAID('UAID_A', null, 'us'),
		api.getAccessTokenForUAID('UAID_B', null, 'eu'),
	]);
	const elapsed = Date.now() - startedAt;

	assert(calls.UAID_A === 1 && calls.UAID_B === 1, 'Expected one refresh per UAID');
	assert(elapsed < 110, `Expected concurrent refresh duration under 110ms, got ${elapsed}ms`);
}

async function testGetHomeInfoUsesZoneEndpoint()
{
	const api = new YoLinkAPI(createMockApp([]));
	let tokenZone = null;
	let requestURL = null;

	api.getAccessTokenForUAID = async (UAID, secret, serviceZone) =>
	{
		tokenZone = serviceZone;
		return 'token';
	};

	api.request = async (method, url) =>
	{
		requestURL = url;
		return { desc: 'Success' };
	};

	await api.getHomeInfo('UAID_A', 'eu');
	assert(tokenZone === 'eu', 'Expected getHomeInfo to request token in eu zone');
	assert(requestURL.indexOf('api-eu.yosmart.com') >= 0, 'Expected getHomeInfo to call EU API endpoint');
}

async function testPostMqttMessagePrefersZoneSpecificClient()
{
	const api = new YoLinkAPI(createMockApp([]));
	let publishedBy = null;

	api.MQTTList = [
		{
			UAID: 'UAID_A',
			serviceZoneID: 'us',
			homeID: 'HOME_US',
			mqttReady: Promise.resolve(),
			MQTTClient: {
				publish: (topic, payload, options, callback) =>
				{
					publishedBy = `us:${topic}:${payload}`;
					if (callback) callback(null);
				},
			},
		},
		{
			UAID: 'UAID_A',
			serviceZoneID: 'eu',
			homeID: 'HOME_EU',
			mqttReady: Promise.resolve(),
			MQTTClient: {
				publish: (topic, payload, options, callback) =>
				{
					publishedBy = `eu:${topic}:${payload}`;
					if (callback) callback(null);
				},
			},
		},
	];

	await api.postMQTTMessage({
		UAID: 'UAID_A',
		serviceZoneID: 'eu',
		command: { method: 'test.command' },
	});

	assert(publishedBy && publishedBy.indexOf('eu:yl-home/HOME_EU/**/request') === 0, `Expected EU MQTT client publish, got ${publishedBy}`);
}

async function testTokenRefreshRestartsMqttClient()
{
	const now = Date.now();
	const api = new YoLinkAPI(createMockApp([
		{
			UAID: 'UAID_A',
			access_token: 'expired_token',
			refresh_token: 'refresh_a',
			expires_at: now - 1000,
		},
	]));

	let oldClientEnded = false;
	let setupArgs = null;
	const replacementClient = {
		publish: () =>
		{},
	};

	api.MQTTList = [
		{
			UAID: 'UAID_A',
			serviceZoneID: 'us',
			homeID: 'HOME_US',
			mqttReady: Promise.resolve(),
			MQTTClient: {
				end: (force) =>
				{
					oldClientEnded = force === true;
				},
			},
		},
	];

	api.obtainAccessTokenWithRefreshToken = async () => ({
		access_token: 'new_token_a',
		refresh_token: 'new_refresh_a',
		expires_in: 3600,
	});

	api.setupMQTTClient = async (brokerConfig) =>
	{
		setupArgs = brokerConfig;
		return {
			UAID: brokerConfig.UAID,
			homeID: 'HOME_US_NEW',
			serviceZoneID: brokerConfig.serviceZoneID,
			mqttReady: Promise.resolve(),
			MQTTClient: replacementClient,
		};
	};

	const token = await api.getAccessTokenForUAID('UAID_A', null, 'us');
	await sleep(10);

	assert(token === 'new_token_a', `Expected refreshed token, got ${token}`);
	assert(oldClientEnded, 'Expected the stale MQTT client to be ended');
	assert(setupArgs && setupArgs.username === 'new_token_a', 'Expected MQTT reconnect to use refreshed token');
	assert(api.MQTTList.some((item) => item.MQTTClient === replacementClient), 'Expected MQTT list to contain the refreshed client');
}

async function testGarageDoorControlUsesAccountUaid()
{
	const device = Object.create(GarageDoorDevice.prototype);
	let capturedArgs = null;

	device.getData = async () => ({
		UAID: 'UAID_ACCOUNT',
		parentDeviceId: 'PARENT_DEVICE_ID',
		parentDeviceUDID: 'PARENT_DEVICE_UDID',
		parentDeviceToken: 'PARENT_DEVICE_TOKEN',
	});
	device.getSettings = async () => ({ serviceZone: 'us' });
	device.homey = {
		app: {
			yoLinkAPI: {
				controlDevice: async (UAID, deviceId, deviceToken, serviceZone, command, params) =>
				{
					capturedArgs = {
						UAID,
						deviceId,
						deviceToken,
						serviceZone,
						command,
						params,
					};
					return { desc: 'Success' };
				},
			},
			updateLog: () => {},
		},
	};

	const result = await device.onOffCapabilityListener(true);

	assert(result === true, 'Expected garage door control to succeed');
	assert(capturedArgs && capturedArgs.UAID === 'UAID_ACCOUNT', `Expected controlDevice to use the account UAID, got ${capturedArgs ? capturedArgs.UAID : 'no call'}`);
	assert(capturedArgs.deviceId === 'PARENT_DEVICE_ID', 'Expected garage door control to target the parent device ID');
	assert(capturedArgs.deviceToken === 'PARENT_DEVICE_TOKEN', 'Expected garage door control to use the parent device token');
	assert(capturedArgs.command === 'GarageDoor.toggle', 'Expected garage door toggle command');
}

function createDoorSensorDevice()
{
	const device = Object.create(DoorSensorDevice.prototype);
	const timers = [];
	const calls = { getState: 0 };
	const availability = [];

	device.getData = () => ({
		id: 'DOOR_1',
		UAID: 'UAID_A',
		type: 'DoorSensor',
		deviceToken: 'DOOR_TOKEN',
	});
	device.getSettings = async () => ({ serviceZone: 'us' });
	device.error = () => {};
	device.setAvailable = async () =>
	{
		availability.push(true);
	};
	device.setUnavailable = async () =>
	{
		availability.push(false);
	};
	device.setWarning = async () => {};
	device.unsetWarning = async () => {};
	device.setCapabilityValue = async () => {};
	device.driver = {
		getState: async () =>
		{
			calls.getState += 1;
			return device.nextState(calls.getState);
		},
		updateMQTTState: () => {},
	};
	device.homey = {
		app: {
			updateLog: () => {},
		},
		setTimeout: (fn, delay) =>
		{
			timers.push({ fn, delay });
			return timers.length;
		},
		clearTimeout: () => {},
	};

	return {
		device, timers, calls, availability,
	};
}

async function testStateRefreshRetriesUntilDeviceIsReached()
{
	const {
		device, timers, calls, availability,
	} = createDoorSensorDevice();
	device.nextState = (attempt) =>
	{
		if (attempt === 1)
		{
			// No access token / no response from the cloud
			return null;
		}
		if (attempt === 2)
		{
			return { code: '010301', desc: 'Access denied due to limits reached' };
		}
		return {
			desc: 'Success',
			data: {
				online: true,
				state: {
					state: 'closed', battery: '4', stateChangedAt: 0, openRemindDelay: 0,
				},
			},
		};
	};

	const firstResult = await device.refreshState();
	assert(firstResult === false, 'Expected first refresh to report failure');
	assert(availability[availability.length - 1] === false, 'Expected device to be marked unavailable after failed refresh');
	assert(timers.length === 1, `Expected one retry to be scheduled, got ${timers.length}`);
	assert(timers[0].delay >= 48000 && timers[0].delay <= 72000, `Expected first retry around 60s, got ${timers[0].delay}`);

	timers[0].fn();
	await sleep(10);
	assert(calls.getState === 2, `Expected second getState call, got ${calls.getState}`);
	assert(timers.length === 2, `Expected a second retry to be scheduled, got ${timers.length}`);
	assert(timers[1].delay >= 96000 && timers[1].delay <= 144000, `Expected second retry around 120s, got ${timers[1].delay}`);

	timers[1].fn();
	await sleep(10);
	assert(calls.getState === 3, `Expected third getState call, got ${calls.getState}`);
	assert(availability[availability.length - 1] === true, 'Expected device to be marked available once reached');
	assert(timers.length === 2, `Expected no further retry after success, got ${timers.length}`);
	assert(device.stateRetryTimer === null, 'Expected retry timer to be cleared after success');
}

async function testStateRefreshRetriesWhenUpdateStateThrows()
{
	const { device, timers, availability } = createDoorSensorDevice();
	device.nextState = () =>
	{
		throw new Error('boom');
	};

	const result = await device.refreshState();
	assert(result === false, 'Expected refresh to report failure when updateState throws');
	assert(timers.length === 1, 'Expected a retry to be scheduled when updateState throws');
	assert(availability.length === 0, 'Expected availability to be left untouched when updateState throws');
}

async function testMqttMessageMarksDeviceOnline()
{
	const { device, availability } = createDoorSensorDevice();

	const handled = await device.processMQTTMessage({
		event: 'DoorSensor.Alert',
		deviceId: 'DOOR_1',
		data: { state: 'open', battery: '3' },
	});
	assert(handled === true, 'Expected MQTT message for this device to be handled');
	assert(availability[availability.length - 1] === true, 'Expected device to be marked available after MQTT message');

	const ignored = await device.processMQTTMessage({
		event: 'DoorSensor.Alert',
		deviceId: 'OTHER',
		data: { state: 'open' },
	});
	assert(ignored === false, 'Expected MQTT message for another device to be ignored');
	assert(availability.length === 1, 'Expected availability not to change for another device');
}

async function main()
{
	const results = [];
	results.push(await runTest('service zone normalization', testServiceZoneNormalization));
	results.push(await runTest('token URL by zone', testTokenURLByZone));
	results.push(await runTest('same UAID refresh is deduped', testSameUaidRefreshIsDeduped));
	results.push(await runTest('different UAID refresh can run concurrently', testDifferentUaidRefreshCanRunConcurrently));
	results.push(await runTest('getHomeInfo uses zone endpoint', testGetHomeInfoUsesZoneEndpoint));
	results.push(await runTest('postMQTTMessage prefers zone-specific client', testPostMqttMessagePrefersZoneSpecificClient));
	results.push(await runTest('token refresh restarts mqtt client', testTokenRefreshRestartsMqttClient));
	results.push(await runTest('garage door control uses account UAID', testGarageDoorControlUsesAccountUaid));
	results.push(await runTest('state refresh retries until device is reached', testStateRefreshRetriesUntilDeviceIsReached));
	results.push(await runTest('state refresh retries when updateState throws', testStateRefreshRetriesWhenUpdateStateThrows));
	results.push(await runTest('mqtt message marks device online', testMqttMessageMarksDeviceOnline));

	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0)
	{
		console.error(`\n${failed.length} harness test(s) failed.`);
		process.exitCode = 1;
		return;
	}

	console.log('\nAll harness tests passed.');
}

main().catch((error) =>
{
	console.error('Harness execution failed.');
	console.error(error);
	process.exitCode = 1;
});
