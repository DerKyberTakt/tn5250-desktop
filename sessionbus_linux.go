package main

import "github.com/godbus/dbus/v5"

// checkSessionBus fails with a readable error when the D-Bus session bus cannot be reached.
func checkSessionBus() error {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return sessionBusError(err)
	}
	_ = conn.Close()
	return nil
}
