SUMMARY = "Package group for Iotistica agent systems"
LICENSE = "MIT"
PR = "r0"

inherit packagegroup

RDEPENDS:${PN} = " \
    iotistica-agent \
    docker \
    ca-certificates \
    curl \
"
