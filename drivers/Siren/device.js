'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class SirenDevice extends YoLinkDevice
{

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit()
	{
		// Add the capability listener for the OnOff capability
		this.registerCapabilityListener('alarm_sirenOnOff', this.onOffCapabilityListener.bind(this));

		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SirenDevice has been initialized');
	}

	/**
	 * onAdded is called when the user adds the device, called just after pairing.
	 */
	async onAdded()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SirenDevice has been added');
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
		this.homey.app.updateLog('SirenDevice settings were changed');
	}

	/**
	 * onRenamed is called when the user updates the device's name.
	 * This method can be used this to synchronise the name to the device.
	 * @param {string} name The new name
	 */
	async onRenamed(name)
	{
		this.homey.app.updateLog('SirenDevice was renamed');
	}

	/**
	 * onDeleted is called when the user deleted the device.
	 */
	async onDeleted()
	{
		this.homey.app.updateLog('SirenDevice has been deleted');
	}

	async onOffCapabilityListener(value)
	{
		const data = await this.getData();
		const settings = await this.getSettings();

		const response = await this.homey.app.yoLinkAPI.controlDevice(data.UAID, data.id, data.deviceToken, settings.serviceZone, 'Siren.setState', { state: { alarm: value } });

		if (response && response.desc === 'Success')
		{
			if (value)
			{
				this.driver.triggerSirenOnFlow(this);
			}
			else
			{
				this.driver.triggerSirenOffFlow(this);
			}
		}
		else
		{
			this.homey.app.updateLog('Failed to control Siren');
			throw new Error(`Failed to control Siren ${response ? response.desc : 'No response'}`);
		}

		return true;
	}

	async updateState()
	{
		const data = await this.getData();
		const settings = await this.getSettings();
		const state = await this.driver.getState(data, settings);
		this.unsetWarning().catch(this.error);
		if (!state || !state.data)
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

		this.setCapabilityValue('alarm_sirenOnOff', state.data.state === 'alert').catch(this.error);
		this.setCapabilityValue('alarm_power', state.data.powerSupply === 'battery').catch(this.error);

		// The returned battery is a string with a level between 0 and 4, so convert to 0 to 1
		if (state.data.battery)
		{
			const batteryLevel = parseInt(state.data.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}

		this.driver.updateMQTTState(data);

		return true;
	}

	async processMQTTMessage(mqttMessage)
	{
		// Check if the event field is present so we know what type of message this is
		const mqttData = mqttMessage.data;
		const { deviceId } = mqttMessage;

		if (deviceId !== this.getData().id)
		{
			return false;
		}

		this.markOnline();

		// Log the device status
		this.homey.app.updateLog(`SirenDevice MQTT message received: ${JSON.stringify(mqttData)}`);

		this.setCapabilityValue('alarm_sirenOnOff', mqttData.state === 'alert').catch(this.error);

		if (mqttMessage.event === 'Siren.StatusChange')
		{
			if (mqttData.state === 'alert')
			{
				this.driver.triggerSirenOnFlow(this);
			}
			else
			{
				this.driver.triggerSirenOffFlow(this);
			}
		}

		if (mqttData.powerSupply)
		{
			this.setCapabilityValue('alarm_power', mqttData.powerSupply === 'battery').catch(this.error);
		}

		if (mqttData.battery)
		{
			const batteryLevel = parseInt(mqttData.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}
		return true;
	}
};
