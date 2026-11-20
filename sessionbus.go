package main

import "fmt"

// sessionBusError turns the result of connecting to the D-Bus session bus into the
// message shown when it is missing. The single-instance lock needs the session bus on
// Linux; without one Wails exits with status 1 and says nothing.
func sessionBusError(connectErr error) error {
	if connectErr == nil {
		return nil
	}
	return fmt.Errorf("no D-Bus session bus (%v): start the app from a desktop session, or run it under dbus-run-session (DBUS_SESSION_BUS_ADDRESS is not usable)", connectErr)
}
