'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class SmartRemoteDevice extends YoLinkDevice
{

	/**
   * onInit is called when the device is initialized.
   */
	async onInit()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SmartRemoteDevice has been initialized');
	}

	/**
   * onAdded is called when the user adds the device, called just after pairing.
   */
	async onAdded()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SmartRemoteDevice has been added');
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
		this.homey.app.updateLog('SmartRemoteDevice settings were changed');
	}

	/**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
	async onRenamed(name)
	{
		this.homey.app.updateLog('SmartRemoteDevice was renamed');
	}

	/**
   * onDeleted is called when the user deleted the device.
   */
	async onDeleted()
	{
		this.homey.app.updateLog('SmartRemoteDevice has been deleted');
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
		this.homey.app.updateLog(`SmartRemoteDevice MQTT message received: ${JSON.stringify(mqttData)}`);

		if (mqttData && mqttData.event)
		{
			this.setCapabilityValue('info', `${mqttData.event.keyMask}: ${mqttData.event.type}`).catch(this.error);

			if (mqttData.event.type === 'Press')
			{
				this.driver.triggerButtonPressed(this, { button: mqttData.event.keyMask });
			}
			else if (mqttData.event.type === 'LongPress')
			{
				this.driver.triggerButtonLongPressed(this, { button: mqttData.event.keyMask });
			}
		}

		if (mqttData && mqttData.battery)
		{
			const batteryLevel = parseInt(mqttData.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}
		return true;
	}
};
