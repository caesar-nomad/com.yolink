/* eslint-disable no-tabs */
/* eslint-disable no-nested-ternary */
/* jslint node: true */

'use strict';

const Homey = require('homey');
/**
 * Base class for drivers
 * @class
 * @extends {Homey.Driver}
 */

module.exports = class yoLinkDriver extends Homey.Driver
{

	async onPair(session)
	{
		const UAIDList = await this.homey.app.yoLinkAPI.getUAIDList();
		let accessToken = null;
		let UAID = null;
		let secretKey = null;

		session.setHandler('showView', async (view) =>
		{
			if (view === 'enter_secret')
			{
				if (UAID && accessToken)
				{
					// We have both UAID and accessToken so we can skip the enter_secret view
					await session.nextView();
				}
			}
		});

		session.setHandler('select_uaid_setup', async () =>
		{
			// Return the list of UAIDs to populate the dropdown
			return UAIDList;
		});

		session.setHandler('select_uaid', async (data) =>
		{
			UAID = data.uaid;

			// Trim whitespace
			UAID = typeof UAID === 'string' ? UAID.trim() : '';
			if (UAID)
			{
				try
				{
					accessToken = await this.homey.app.yoLinkAPI.getAccessTokenForUAID(UAID, null);
				}
				catch (err)
				{
					// Token refresh may fail (e.g. expired refresh_token or network not ready).
					// Fall through to enter_secret so the user can re-enter their SecretKey.
					accessToken = null;
				}
			}

			// return true to continue so the secret can be entered if the access token could not be obtained
			await session.nextView();
			return true;
		});

		session.setHandler('enter_secret', async (data) =>
		{
			secretKey = data.secret;

			// trim whitespace
			secretKey = typeof secretKey === 'string' ? secretKey.trim() : '';
			accessToken = await this.homey.app.yoLinkAPI.getAccessTokenForUAID(UAID, secretKey);

			if (accessToken)
			{
				await session.nextView();
				return true;
			}
			throw new Error('Failed to obtain access token, please check your UAID and Secret Key');
		});

		session.setHandler('list_devices', async () =>
		{
			this.log('list_devices');
			if (!accessToken)
			{
				throw new Error('No access token, cannot list devices');
			}

			let deviceList = [];

			const simData = this.homey.app.getSymData();
			if (simData)
			{
				deviceList = simData;
			}
			else
			{
				const deviceusList = await this.homey.app.yoLinkAPI.getDeviceList(UAID, null, 'us');
				const deviceeuList = await this.homey.app.yoLinkAPI.getDeviceList(UAID, null, 'eu_uk');
				deviceList = deviceusList || [];

				// Add the EU devices to the list if not already present
				if (deviceeuList && deviceeuList.length > 0)
				{
					for (const deviceeu of deviceeuList)
					{
						if (!deviceList.find((device) => device.UID === deviceeu.UID))
						{
							deviceList.push(deviceeu);
						}
					}
				}

				if (!deviceusList)
				{
					return [];
				}
			}

			// Filter the list to just include devices of this type
			const filteredList = deviceList.filter((device) => device.type === this.deviceType);

			// If a subType is specified, filter the list to just include devices that also have a device that matches the parentDeviceId that matches the subType
			if (this.subType)
			{
				// Get the list of parent devices that match the subType
				const parentDeviceList = deviceList.filter((device) => device.type === this.subType);

				// make sure we store the parent device id, deviceUDID and token in the data so we can use it later to link the child device to the parent device
				return filteredList.filter((device) => device.parentDeviceId && parentDeviceList.find((parentDevice) => parentDevice.deviceId === device.parentDeviceId && parentDevice.type === this.subType)).map((device) => ({
					name: device.name,
					data:
					{
						id: device.deviceId,
						deviceUDID: device.deviceUDID,
						deviceToken: device.token,
						parentDeviceId: device.parentDeviceId,
						parentDeviceUDID: parentDeviceList.find((parentDevice) => parentDevice.deviceId === device.parentDeviceId && parentDevice.type === this.subType)?.deviceUDID,
						parentDeviceToken: parentDeviceList.find((parentDevice) => parentDevice.deviceId === device.parentDeviceId && parentDevice.type === this.subType)?.token,
						UAID,
						type: device.type,
					},
					icon: this.getIcon ? this.getIcon(device.modelName) : null,
					settings: {
						serviceZone: device.serviceZone ? device.serviceZone : (device.modelName?.endsWith('-EC') ? 'eu_uk' : 'us'),
					},
				}));
			}

			return filteredList.map((device) => ({
				name: device.name,
				data:
				{
					id: device.deviceId,
					deviceUDID: device.deviceUDID,
					deviceToken: device.token,
					parentDeviceId: device.parentDeviceId,
					UAID,
					type: device.type,
				},
				icon: this.getIcon ? this.getIcon(device.modelName) : null,
				settings: {
					serviceZone: device.serviceZone ? device.serviceZone : (device.modelName?.endsWith('-EC') ? 'eu_uk' : 'us'),
				},
			}));
		});
	}

	async onRepair(session, device)
	{
		session.setHandler('login', async (data) =>
		{
			const UAID = typeof data.username === 'string' ? data.username.trim() : '';
			const secretKey = typeof data.password === 'string' ? data.password.trim() : '';
			const serviceZone = device.getSetting('serviceZone');
			const accessToken = await this.homey.app.yoLinkAPI.getAccessTokenForUAID(UAID, secretKey, serviceZone);
			const credentialsAreValid = (accessToken !== null);
			// return true to continue adding the device if the login succeeded
			// return false to indicate to the user the login attempt failed
			// thrown errors will also be shown to the user
			return credentialsAreValid;
		});
	}

	async getState(data, settings)
	{
		return this.homey.app.yoLinkAPI.getDeviceStatus(data.UAID, data.type, data.id, data.deviceToken, settings.serviceZone);
	}

	updateMQTTState(data)
	{
		const command = {
			method: `${data.type}.getState`,
			time: Math.floor(Date.now() / 1000),
			targetDevice: data.id,
			token: data.deviceToken,
			params: {},
		};

		const mqttMessage = {
			UAID: data.UAID,
			command,
		};

		this.homey.app.yoLinkAPI.postMQTTMessage(mqttMessage);
	}

	triggerButtonPressed(device, tokens)
	{
		this.homey.app._triggerButtonPressed.trigger(device, tokens).catch(this.homey.app.error);
		return this;
	}

	triggerButtonLongPressed(device, tokens)
	{
		this.homey.app._triggerButtonLongPressed.trigger(device, tokens).catch(this.homey.app.error);
		return this;
	}

};
