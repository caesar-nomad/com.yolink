'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class WaterDepthSensorDevice extends YoLinkDevice
{

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit()
	{
		this.refreshState().catch(this.error);
		this.log('WaterDepthSensorDevice has been initialized');
	}

	/**
	 * onAdded is called when the user adds the device, called just after pairing.
	 */
	async onAdded()
	{
		this.log('WaterDepthSensorDevice has been added');
	}

	/**
	 * onSettings is called when the user updates the device's settings.
	 * @param {object} event the onSettings event data
	 * @param {object} event.oldSettings The old settings object
	 * @param {object} event.newSettings The new settings object
	 * @param {string[]} event.changedKeys An array of keys changed since the previous version
	 * @returns {Promise<string|void>} return a custom message that will be displayed
	 */
	async onSettings({ oldSettings, newSettings, changedKeys })
	{
		if (changedKeys.includes('tankDepth'))
		{
			const tankDepth = Number(newSettings.tankDepth);
			if (!Number.isFinite(tankDepth) || tankDepth <= 0)
			{
				throw new Error('Tank depth must be a positive number in meters.');
			}
		}

		if (changedKeys.includes('liquidDensity'))
		{
			const density = Number(newSettings.liquidDensity);
			if (!Number.isFinite(density) || density <= 0)
			{
				throw new Error('Liquid density must be a positive number (use 1.0 for water).');
			}
		}

		if (changedKeys.includes('lowDepthThreshold'))
		{
			const low = Number(newSettings.lowDepthThreshold);
			if (!Number.isFinite(low) || low < 0)
			{
				throw new Error('Low depth threshold must be 0 or a positive number in meters.');
			}
		}

		if (changedKeys.includes('highDepthThreshold'))
		{
			const high = Number(newSettings.highDepthThreshold);
			if (!Number.isFinite(high) || high < 0)
			{
				throw new Error('High depth threshold must be 0 or a positive number in meters.');
			}
		}

		this.log('WaterDepthSensorDevice settings were changed');
	}

	/**
	 * onRenamed is called when the user updates the device's name.
	 * This method can be used this to synchronise the name to the device.
	 * @param {string} name The new name
	 */
	async onRenamed(name)
	{
		this.log('WaterDepthSensorDevice was renamed');
	}

	/**
	 * onDeleted is called when the user deleted the device.
	 */
	async onDeleted()
	{
		this.log('WaterDepthSensorDevice has been deleted');
	}

	async updateState()
	{
		const data = await this.getData();
		const settings = await this.getSettings();
		const state = await this.driver.getState(data, settings);
		this.unsetWarning().catch(this.error);
		if (!state || !state.data || !state.data.online || state.data.online !== true)
		{
			if (state && state.state === 'error')
			{
				this.homey.app.updateLog(`Error updating state for device ${data.id}: ${state.msg}`, 0);
				this.setWarning(`Error: ${state.msg}`).catch(this.error);
				return false;
			}
			this.setUnavailable('Offline').catch(this.error);
			return false;
		}
		this.setAvailable().catch(this.error);

		const depthInCm = this.calculateDepthInCm(state.data.state.waterDepth, settings.sensorRange, settings.liquidDensity);
		const displayValue = this.calculateDisplayValue(depthInCm);
		this.setCapabilityValue('measure_water_depth', displayValue).catch(this.error);
		this.setWaterAlarms(depthInCm, state.data.state.alarm.lowAlarm, state.data.state.alarm.highAlarm, settings);

		// The returned battery is a string with a level between 0 and 4, so convert to 0 to 1
		if (state.data.state.battery)
		{
			const batteryLevel = parseInt(state.data.state.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}

		this.driver.updateMQTTState(data);

		return true;
	}

	async processMQTTMessage(mqttMessage)
	{
		const settings = await this.getSettings();
		let mqttData;
		let deviceId;
		// Check if the event field is present so we know what type of message this is
		if (mqttMessage.event)
		{
			mqttData = mqttMessage.data;
			deviceId = mqttMessage.deviceId;
		}
		else
		{
			mqttData = mqttMessage.data.state;
			deviceId = mqttMessage.targetDevice;
		}

		if (deviceId !== this.getData().id)
		{
			return false;
		}

		this.markOnline();

		// Log the device status
		this.homey.app.updateLog(`WaterDepthSensorDevice MQTT message received: ${JSON.stringify(mqttData)}`);

		// Process the MQTT message
		if (mqttData.battery)
		{
			const batteryLevel = parseInt(mqttData.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}

		if (mqttData.state)
		{
			const depthInCm = this.calculateDepthInCm(mqttData.state.waterDepth, settings.sensorRange, settings.liquidDensity);
			const displayValue = this.calculateDisplayValue(depthInCm);
			this.setCapabilityValue('measure_water_depth', displayValue).catch(this.error);
			this.setWaterAlarms(depthInCm, mqttData.state.alarm.lowAlarm, mqttData.state.alarm.highAlarm, settings);
		}

		return true;
	}

	// Returns actual depth in cm: formula = (sensorRange * rawWaterDepth) / liquidDensity
	// sensorRange: 0.5 for 5m cable, 1.0 for 10m cable
	// rawWaterDepth: integer value from YoLink API
	// liquidDensity: 1.0 for water
	calculateDepthInCm(rawWaterDepth, sensorRange, liquidDensity)
	{
		const raw = Number(rawWaterDepth);
		const range = Number(sensorRange);
		const density = Number(liquidDensity);

		if (!Number.isFinite(raw) || raw < 0)
		{
			return 0;
		}

		// If sensor cable / density not yet configured, return raw value in metres as a safe fallback
		if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(density) || density <= 0)
		{
			return raw / 100;
		}

		return (range * raw) / density;
	}

	// Returns depth in metres for display on the device card
	calculateDisplayValue(depthInCm)
	{
		return depthInCm / 100;
	}

	// Evaluates alarms against Homey-side metre thresholds.
	// Falls back to YoLink's own alarm flags when thresholds are left at 0.
	setWaterAlarms(depthInCm, yolinkLowAlarm, yolinkHighAlarm, settings)
	{
		const depthInMeters = depthInCm / 100;
		const lowThreshold = Number(settings.lowDepthThreshold);
		const highThreshold = Number(settings.highDepthThreshold);

		const lowAlarm = (Number.isFinite(lowThreshold) && lowThreshold > 0)
			? depthInMeters <= lowThreshold
			: yolinkLowAlarm;

		const highAlarm = (Number.isFinite(highThreshold) && highThreshold > 0)
			? depthInMeters >= highThreshold
			: yolinkHighAlarm;

		this.setCapabilityValue('alarm_water.low', lowAlarm).catch(this.error);
		this.setCapabilityValue('alarm_water.high', highAlarm).catch(this.error);
	}
};
