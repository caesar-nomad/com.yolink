'use strict';

const Homey = require('homey');

module.exports = class THDevice extends Homey.Device
{

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit()
	{
		this.updateState().catch((err) => this.error(err));
		this.homey.app.updateLog('THDevice has been initialized');
	}

	/**
	 * onAdded is called when the user adds the device, called just after pairing.
	 */
	async onAdded()
	{
		this.homey.app.updateLog('THDevice has been added');
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
		this.homey.app.updateLog('THDevice settings were changed');
	}

	/**
	 * onRenamed is called when the user updates the device's name.
	 * This method can be used this to synchronise the name to the device.
	 * @param {string} name The new name
	 */
	async onRenamed(name)
	{
		this.homey.app.updateLog('THDevice was renamed');
	}

	/**
	 * onDeleted is called when the user deleted the device.
	 */
	async onDeleted()
	{
		this.homey.app.updateLog('THDevice has been deleted');
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
				return;
			}
			this.setUnavailable('Offline').catch(this.error);
			return;
		}
		this.setAvailable().catch(this.error);

		this.setCapabilityValue('measure_temperature', state.data.state.temperature).catch(this.error);
		await this.updateHumidity(state.data.state.humidity);

		// The returned battery is a level between 0 and 4 (0 = empty), so convert to 0 to 100
		const batteryLevel = this.driver.getBatteryPercentage(state.data.state.battery);
		if (batteryLevel !== null)
		{
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}
	}

	// Temperature-only models (e.g. probe sensors) use the THSensor type but always report a humidity of 0.
	// Show humidity only once the device has reported a non-zero value, so these models don't show a false 0%.
	async updateHumidity(humidity)
	{
		if (typeof humidity !== 'number')
		{
			return;
		}

		if (humidity !== 0 && !this.getStoreValue('humidityReported'))
		{
			await this.setStoreValue('humidityReported', true).catch(this.error);
		}

		if (this.getStoreValue('humidityReported'))
		{
			if (!this.hasCapability('measure_humidity'))
			{
				this.homey.app.updateLog('THDevice reported humidity, adding measure_humidity capability');
				await this.addCapability('measure_humidity').catch(this.error);
			}
			this.setCapabilityValue('measure_humidity', humidity).catch(this.error);
		}
		else if (this.hasCapability('measure_humidity'))
		{
			this.homey.app.updateLog('THDevice has not reported humidity, removing measure_humidity capability');
			await this.removeCapability('measure_humidity').catch(this.error);
		}
	}

	async processMQTTMessage(mqttMessage)
	{
		if (mqttMessage.deviceId !== this.getData().id)
		{
			return false;
		}

		// Log the device status
		this.homey.app.updateLog(`TemperatureAndHumidityDevice MQTT message received: ${JSON.stringify(mqttMessage)}`);

		// Process the MQTT message
		if (mqttMessage.event === 'THSensor.Report')
		{
			if (typeof mqttMessage.data.temperature === 'number')
			{
				this.setCapabilityValue('measure_temperature', mqttMessage.data.temperature).catch(this.error);
			}
			await this.updateHumidity(mqttMessage.data.humidity);
			const batteryLevel = this.driver.getBatteryPercentage(mqttMessage.data.battery);
			if (batteryLevel !== null)
			{
				this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
			}
		}
		return true;
	}

};
