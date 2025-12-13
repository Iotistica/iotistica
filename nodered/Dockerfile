FROM nodered/node-red:latest

USER root

# Copy only plugin source files (excluding node_modules)
COPY data/@iotistic/nr-devices-plugin/package*.json /data/@iotistic/nr-devices-plugin/
COPY data/@iotistic/nr-devices-plugin/dist /data/@iotistic/nr-devices-plugin/dist

COPY data/@iotistic/nr-auth/package*.json /data/@iotistic/nr-auth/
COPY data/@iotistic/nr-auth/lib /data/@iotistic/nr-auth/lib

COPY data/@iotistic/nr-storage/package*.json /data/@iotistic/nr-storage/
COPY data/@iotistic/nr-storage/*.js /data/@iotistic/nr-storage/

# Copy Node-RED config files
COPY data/package.json /data/
COPY data/settings.js /data/settings.js

# Ensure all /data files belong to node-red
RUN chown -R node-red:node-red /data

# Switch back to node-red user
USER node-red

WORKDIR /usr/src/node-red

# Install theme
RUN npm install --no-fund --no-update-notifier --save @node-red-contrib-themes/theme-collection

# Install plugin dependencies directly in /data
WORKDIR /data/@iotistic/nr-auth
RUN npm install --no-fund --no-update-notifier --production

WORKDIR /data/@iotistic/nr-devices-plugin
RUN npm install --no-fund --no-update-notifier --production

WORKDIR /data/@iotistic/nr-storage
RUN npm install --no-fund --no-update-notifier --production

# Install plugins into Node-RED
WORKDIR /usr/src/node-red
RUN npm install --no-fund --no-update-notifier /data/@iotistic/nr-devices-plugin
RUN npm install --no-fund --no-update-notifier /data/@iotistic/nr-auth
RUN npm install --no-fund --no-update-notifier /data/@iotistic/nr-storage
