SUMMARY = "Iotistica IoT Device Agent"
DESCRIPTION = "Container orchestrator and cloud-sync agent for Iotistica devices"
HOMEPAGE = "https://github.com/Iotistica/iotistica"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit systemd useradd

DEPENDS = "nodejs-native"
RDEPENDS:${PN} = "bash nodejs docker"

# Override these from your build conf or a .bbappend for your own source mirror/tag.
SRC_URI = "git://github.com/Iotistica/iotistica.git;branch=master;protocol=https"
SRCREV = "${AUTOREV}"
PV = "1.0+git${SRCPV}"

S = "${WORKDIR}/git/agent"

SYSTEMD_AUTO_ENABLE:${PN} = "enable"
SYSTEMD_SERVICE:${PN} = "iotistica-agent.service"

USERADD_PACKAGES = "${PN}"
GROUPADD_PARAM:${PN} = "-r iotistica"
USERADD_PARAM:${PN} = "-r -g iotistica -d /var/lib/iotistica -s /sbin/nologin iotistica"

do_compile() {
    cd ${S}
    npm ci --omit=dev
    npm run build
}

do_install() {
    install -d ${D}/opt/iotistica/agent
    install -d ${D}${sysconfdir}/iotistica
    install -d ${D}${systemd_system_unitdir}
    install -d ${D}/var/lib/iotistica
    install -d ${D}/var/log/iotistica

    cp -r ${S}/dist ${D}/opt/iotistica/agent/
    install -m 0644 ${S}/package.json ${D}/opt/iotistica/agent/

    install -m 0644 ${WORKDIR}/iotistica-agent.service ${D}${systemd_system_unitdir}/iotistica-agent.service
    install -m 0644 ${WORKDIR}/agent.env ${D}${sysconfdir}/iotistica/agent.env
}

SRC_URI += " \
    file://iotistica-agent.service \
    file://agent.env \
"

FILES:${PN} += " \
    /opt/iotistica/agent \
    ${sysconfdir}/iotistica/agent.env \
    ${systemd_system_unitdir}/iotistica-agent.service \
    /var/lib/iotistica \
    /var/log/iotistica \
"
