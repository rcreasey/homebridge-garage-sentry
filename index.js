var Promise = require("bluebird");
var rp = require("request-promise");
var util = require("util");
var Service, Characteristic, DoorState;

var uuid = homebridge.hap.uuid;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  DoorState = homebridge.hap.Characteristic.CurrentDoorState;
  uuid = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-garage-sentry", "Garage Sentry", GarageSentry);
};

function GarageSentry(log, config) {
  this.log = log;
  this.config = config;
  
  this.access_token = config.access_token;
  this.device_id = config.device_id;
  this.url = config.url || 'https://api.spark.io/v1';
}

GarageSentry.prototype = {
  accessories: function(callback) {
    this.log("Fetching Garage Sentry devices.");
    var accessory = new GarageSentryAccessory(this.log, this.url, this.access_token, this.device_id);
    callback([accessory]);
  }
};

function GarageSentryAccessory(log, url, access_token, device_id) {
  this.log = log;
  this.name = 'Garage Door';
  
  this.api_options = {
    method: 'GET',
    uri: [url, 'devices', device_id].join('/'),
    headers: {'Authorization': util.format('Bearer %s', access_token)}
  };
  
  this.poll_rate = 2000;
  this.door_timeout = 6000;
  this.initService();
}

GarageSentryAccessory.prototype = {
  initService: function() {
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'GarageSentry');
    
    this.informationService
      .setCharacteristic(Characteristic.Model, 'Garage Door')
      .setCharacteristic(Characteristic.SerialNumber, this.device_id);
        
    this.service = new Service.GarageDoorOpener(this.name, uuid.generate('garage-sentry:garage_door'));

    this.operating = false;

    var that = this;
    
    this.checkDeviceState()
      .then(function(is_closed) {
        that.currentDoorState = that.service.getCharacteristic(DoorState);
        that.currentDoorState.on('get', that.getState.bind(that));
        
        that.targetDoorState = that.service.getCharacteristic(Characteristic.TargetDoorState);
        that.targetDoorState.on('set', that.setState.bind(that));
        that.targetDoorState.on('get', that.getTargetState.bind(that));
        
        that.currentDoorState.setValue(is_closed ? DoorState.CLOSED : DoorState.OPEN);
        that.targetDoorState.setValue(is_closed ? DoorState.CLOSED : DoorState.OPEN);
      })
      .fail(function(error) {
        that.log("Failed on checkDeviceState.  Setting closed.");
        that.currentDoorState.setValue(DoorState.CLOSED);
        that.targetDoorState.setValue(DoorState.CLOSED);
      });
    
    setTimeout(this.monitorState.bind(this), this.poll_rate);
  },
    
  particle_request: function(method, uri) {
    var options = util._extend({method: method}, this.api_options);
    options.uri += uri;
    
    return rp(options)
             .then(function(parsedBody) {
               var body = JSON.parse(parsedBody);
               this.token = body.access_token;
               return body;
             }.bind(this));
  },
    
  checkDeviceState: function() {
    device_state = particle_request('get', 'door_status')
      .then(function(response) {
        
        var state = response.result;
        return (state === 'Door Closed') ? true : false;
      })
      .fail(function(error) {
        that.log("Failed on checkDeviceState promise.  Resolving true.");
        return true;
      });
      
    return Promise.fromCallback(device_state);
  },
    
  getTargetState: function(callback) {
    callback(null, this.targetState);
  },
    
  setFinalDoorState: function() {
    var that = this;
    
    this.checkDeviceState()
      .then(function(is_closed) {
        that.currentDoorState.setValue(that.targetState);
        if ((that.targetState == DoorState.CLOSED && !is_closed) || (that.targetState == DoorState.OPEN && is_closed)) {
          var desired_state = that.targetState == DoorState.CLOSED ? "Close" : "Open";
          var current_state = is_closed ? "Closed" : "Open";
          
          that.log(util.format("Trying to %s the Garage Door, but it's still %s", desired_state, current_state));
          that.currentDoorState.setValue(DoorState.STOPPED);
          that.targetDoorState.setValue(is_closed ? DoorState.CLOSED : DoorState.OPEN);
        } else {
          that.currentDoorState.setValue(that.targetState);
        }

        that.operating = false;
      })
      .fail(function(error) {
        that.log("Failed in setFinalDoorState.");
      });
  },
    
  getState: function(callback) {
    var that = this;
    
    this.checkDeviceState()
      .then(function(is_closed) {
        var state = is_closed ? DoorState.CLOSED : DoorState.OPEN;
        that.log(util.format("Current state of the Garage Door is: %s (%s)", (is_closed ? "Closed" : "Opened"), state));

        callback(null, state);
      })
      .fail(function(error) {
        that.log("Failed in getState.  Setting closed.");
        callback(null, DoorState.CLOSED);
      });
  },
    
  setState: function(state, callback) {
    var that = this;
    
    this.checkDeviceState()
      .then(function(is_closed) {
        that.targetState = state;
        if ((state == DoorState.OPEN && is_closed) || (state == DoorState.CLOSED && !is_closed)) {
          that.operating = true;
          
          if (state == DoorState.OPEN) {
            that.currentDoorState.setValue(DoorState.OPENING);
          } else {
            that.currentDoorState.setValue(DoorState.CLOSED);
          }
          
          setTimeout(that.setFinalDoorState.bind(that), that.door_timeout);
          //that.particle_request('post', 'door_toggle');
        }
        
        callback();
        return true;
      })
      .fail(function(error) {
        that.log("Failed on setState.");
        callback();
      });
  },
    
  monitorState: function() {
    var that = this;
    
    this.checkDeviceState()
      .then(function(is_closed) {
        if (is_closed != that.wasClosed) {
          that.wasClosed = is_closed;
          var state = is_closed ? DoorState.CLOSED : DoorState.OPEN;
          that.log(util.format("Garage Door state changed to: %s (%s)", (is_closed ? "Closed" : "Opened"), state));
          
          if (!that.operating) {
            that.currentDoorState.setValue(state);
            that.targetDoorState.setValue(state);
            that.targetState = state;
          }
        }
        
        setTimeout(that.monitorState.bind(that), that.poll_rate);
      });

  },
    
  getServices: function() {
    return [this.informationService, this.service];
  }
};
