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

Module._load = originalModuleLoad;

// yoLinkAPI.normalizeUAID/isValidNormalizedUAID require the canonical `ua_` + 32 hex-char format.
const UAID_A = `ua_${'A'.repeat(32)}`;
const UAID_B = `ua_${'B'.repeat(32)}`;
const UAID_ACCOUNT = `ua_${'C'.repeat(32)}`;

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
			UAID: UAID_A,
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
		api.getAccessTokenForUAID(UAID_A, null, 'us'),
		api.getAccessTokenForUAID(UAID_A, null, 'us'),
	]);

	assert(refreshCalls === 1, `Expected one refresh call, got ${refreshCalls}`);
	assert(results[0] === 'new_token_a' && results[1] === 'new_token_a', 'Expected both calls to return refreshed token');
}

async function testDifferentUaidRefreshCanRunConcurrently()
{
	const now = Date.now();
	const api = new YoLinkAPI(createMockApp([
		{
			UAID: UAID_A,
			access_token: 'expired_a',
			refresh_token: 'refresh_a',
			expires_at: now - 1000,
		},
		{
			UAID: UAID_B,
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
		api.getAccessTokenForUAID(UAID_A, null, 'us'),
		api.getAccessTokenForUAID(UAID_B, null, 'eu'),
	]);
	const elapsed = Date.now() - startedAt;

	assert(calls[UAID_A] === 1 && calls[UAID_B] === 1, 'Expected one refresh per UAID');
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

	await api.getHomeInfo(UAID_A, 'eu');
	assert(tokenZone === 'eu', 'Expected getHomeInfo to request token in eu zone');
	assert(requestURL.indexOf('api-eu.yosmart.com') >= 0, 'Expected getHomeInfo to call EU API endpoint');
}

async function testPostMqttMessagePrefersZoneSpecificClient()
{
	const api = new YoLinkAPI(createMockApp([]));
	let publishedBy = null;

	api.MQTTList = [
		{
			UAID: UAID_A,
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
			UAID: UAID_A,
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
		UAID: UAID_A,
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
			UAID: UAID_A,
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
			UAID: UAID_A,
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

	const token = await api.getAccessTokenForUAID(UAID_A, null, 'us');
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
		UAID: UAID_ACCOUNT,
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
	assert(capturedArgs && capturedArgs.UAID === UAID_ACCOUNT, `Expected controlDevice to use the account UAID, got ${capturedArgs ? capturedArgs.UAID : 'no call'}`);
	assert(capturedArgs.deviceId === 'PARENT_DEVICE_ID', 'Expected garage door control to target the parent device ID');
	assert(capturedArgs.deviceToken === 'PARENT_DEVICE_TOKEN', 'Expected garage door control to use the parent device token');
	assert(capturedArgs.command === 'GarageDoor.toggle', 'Expected garage door toggle command');
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
