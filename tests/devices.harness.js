/* eslint-disable no-console, max-classes-per-file */

'use strict';

const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain)
{
	if (request === 'homey')
	{
		return {
			Driver: class DriverStub
			{},
			Device: class DeviceStub
			{},
		};
	}

	return originalModuleLoad.call(this, request, parent, isMain);
};

const YoLinkDriver = require('../drivers/yoLinkDriver');
const THDevice = require('../drivers/temperature-and-humidity/device');

Module._load = originalModuleLoad;

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

function createTHDevice(capabilities, store = {})
{
	const device = new THDevice();
	const caps = new Map(capabilities.map((capability) => [capability, null]));
	device.hasCapability = (capability) => caps.has(capability);
	device.addCapability = async (capability) => caps.set(capability, null);
	device.removeCapability = async (capability) => caps.delete(capability);
	device.setCapabilityValue = async (capability, value) =>
	{
		if (!caps.has(capability))
		{
			throw new Error(`Missing capability ${capability}`);
		}
		caps.set(capability, value);
	};
	device.getStoreValue = (key) => store[key];
	device.setStoreValue = async (key, value) =>
	{
		store[key] = value;
	};
	device.error = () =>
	{};
	device.homey = { app: { updateLog: () =>
	{} } };
	return { device, caps, store };
}

async function testBatteryPercentageReportsEmptyBattery()
{
	const driver = new YoLinkDriver();
	assert(driver.getBatteryPercentage(0) === 0, 'Expected level 0 to be 0%');
	assert(driver.getBatteryPercentage('0') === 0, 'Expected level "0" to be 0%');
	assert(driver.getBatteryPercentage(1) === 25, 'Expected level 1 to be 25%');
	assert(driver.getBatteryPercentage('4') === 100, 'Expected level "4" to be 100%');
	assert(driver.getBatteryPercentage(7) === 100, 'Expected out of range level to be clamped to 100%');
	assert(driver.getBatteryPercentage(undefined) === null, 'Expected missing level to be null');
	assert(driver.getBatteryPercentage('') === null, 'Expected empty level to be null');
}

async function testHumidityRemovedForTemperatureOnlySensor()
{
	const { device, caps } = createTHDevice(['measure_temperature', 'measure_humidity', 'measure_battery']);
	await device.updateHumidity(0);
	assert(!caps.has('measure_humidity'), 'Expected humidity to be removed when only 0 has been reported');
	await device.updateHumidity(undefined);
	assert(!caps.has('measure_humidity'), 'Expected missing humidity to leave the capabilities unchanged');
}

async function testHumidityKeptForHumiditySensor()
{
	const { device, caps, store } = createTHDevice(['measure_temperature', 'measure_humidity', 'measure_battery']);
	await device.updateHumidity(45);
	assert(caps.get('measure_humidity') === 45, 'Expected humidity value to be set');
	assert(store.humidityReported === true, 'Expected humidityReported to be stored');
	await device.updateHumidity(0);
	assert(caps.get('measure_humidity') === 0, 'Expected 0% to be kept once humidity has been reported');
}

async function testHumidityRestoredWhenReportedLater()
{
	const { device, caps } = createTHDevice(['measure_temperature', 'measure_battery']);
	await device.updateHumidity(30);
	assert(caps.get('measure_humidity') === 30, 'Expected humidity to be added back when a value is reported');
}

async function main()
{
	const results = [];
	results.push(await runTest('battery level 0 is reported as 0%', testBatteryPercentageReportsEmptyBattery));
	results.push(await runTest('humidity removed for temperature-only sensor', testHumidityRemovedForTemperatureOnlySensor));
	results.push(await runTest('humidity kept for humidity sensor', testHumidityKeptForHumiditySensor));
	results.push(await runTest('humidity restored when reported later', testHumidityRestoredWhenReportedLater));

	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0)
	{
		console.error(`\n${failed.length} device harness test(s) failed.`);
		process.exitCode = 1;
		return;
	}

	console.log('\nAll device harness tests passed.');
}

main().catch((error) =>
{
	console.error('Device harness execution failed.');
	console.error(error);
	process.exitCode = 1;
});
