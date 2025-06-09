const { createBot, createProvider, createFlow, addKeyword, addAnswer } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const https = require('https');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit'); // Importa PDFKit para generación de PDF
const fs = require('fs'); // Importa fs para manejar archivos si es necesario, aunque el PDF será un buffer para el correo
const qrcode = require('qrcode'); // CAMBIADO: Importa qrcode

// Estado temporal de usuarios (memoria volátil)
const rutasDeConversacion = new Map();
const TIMEOUT_SESION_MS = 60 * 1000; // 1 minuto de inactividad

// Función para obtener la hora actual en formato HH:MM:SS
const getCurrentTime = () => {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
};

// Función para formatear el mensaje de console.log
const formatMessageLog = (direction, from, message) => {
    const time = getCurrentTime();
    const directionLabel = direction === 'sent' ? 'BOT ->' : '<- USER';
    const messageContent = typeof message === 'string' ? message : JSON.stringify(message);
    return `[${time}] ${directionLabel} ${from}: ${messageContent}`;
};

// Función para obtener la fecha de entrega (sábado o domingo más cercano) - Adaptada para AVANT LIMA
const getNextDeliveryDate = () => {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    let daysToAdd;

    if (dayOfWeek === 0) { // Si es domingo, la entrega es hoy
        daysToAdd = 0;
    } else if (dayOfWeek === 6) { // Si es sábado, la entrega es hoy
        daysToAdd = 0;
    } else if (dayOfWeek < 6) { // Si es de lunes a viernes, la entrega es el próximo sábado
        daysToAdd = 6 - dayOfWeek;
    }

    const nextDeliveryDate = new Date(today);
    nextDeliveryDate.setDate(today.getDate() + daysToAdd);

    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    return nextDeliveryDate.toLocaleDateString('es-ES', options);
};

// Validación de DNI con Apiperu
const validarDni = async (dni, token) => {
    const opciones = {
        hostname: 'apiperu.dev',
        path: '/api/dni',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };
    return new Promise((resolve, reject) => {
        const req = https.request(opciones, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.write(JSON.stringify({ dni }));
        req.end();
    });
};

// NUEVA FUNCIÓN: Generar Cartel QR (Anuncio Inmobiliario)
const generarCartelQRPDF = async (propiedadInfo, mensajePersonalizado, numeroTelefonoCliente, tipoServicio) => {
    const whatsappLink = `https://wa.me/${numeroTelefonoCliente}?text=${encodeURIComponent(mensajePersonalizado)}`;
    const qrCodeBuffer = await qrcode.toBuffer(whatsappLink, {
        errorCorrectionLevel: 'H',
        width: 150, // Tamaño ajustado para el cartel
        margin: 1
    });

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [400, 300], // Tamaño del cartel, ajustado a lo que parece en la imagen
            margin: 20,
            info: {
                Title: `Cartel QR AVANT LIMA - ${propiedadInfo.operacion}`,
                Author: 'AVANT LIMA Perú'
            },
            permissions: {
                printing: 'highResolution', modifying: false, copying: false, annotating: true,
                fillingForms: true, contentAccessibility: true, documentAssembly: true
            },
            userPassword: propiedadInfo.dni // Protegido con DNI
        });

        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });
        doc.on('error', reject);

        const usableWidth = doc.page.width - 2 * doc.page.margins.left;
        const startX = doc.page.margins.left;
        let currentY = doc.page.margins.top;

        // Banner Superior "SE VENDE" / "SE ALQUILA"
        doc.rect(startX, currentY, usableWidth, 40).fill('#E44D26'); // Rojo llamativo
        doc.fillColor('white').fontSize(24).text(`SE ${propiedadInfo.operacion.toUpperCase()}`, startX, currentY + 8, {
            width: usableWidth, 
            align: 'center'
        });
        currentY += 50; // Espacio después del banner

        // Logo (Se comenta para no incluir el logo)
        // doc.image('Logo Somos Marketing Peru SACs.png', startX, currentY, { width: 50 }); // Asegúrate de que esta imagen exista
        currentY += 60; // Espacio después del logo (se mantiene el espacio para que el layout no se rompa drásticamente)

        // QR Code
        const qrX = startX + (usableWidth / 2) - (150 / 2); // Centrar QR
        doc.image(qrCodeBuffer, qrX, currentY, { width: 150, height: 150 });
        currentY += 160; // Espacio después del QR

        // Textos de Información
        doc.fillColor('#444444').fontSize(10);
        doc.text('INFORMACIÓN', startX, currentY);
        doc.text('PRECIO', startX + usableWidth / 4, currentY, { align: 'center' });
        doc.text('FOTOS', startX + usableWidth / 2, currentY, { align: 'center' });
        doc.text('CONTACTO', startX + usableWidth * 3 / 4, currentY, { align: 'right' });
        currentY += 20;

        doc.fontSize(8).text('Escanear QR para más detalles y contacto directo.', startX, currentY, { align: 'center', width: usableWidth });

        doc.end();
    });
};

// NUEVA FUNCIÓN: Generar Ficha Técnica PDF
const generarFichaTecnicaPDF = async (propiedadInfo) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 50,
            info: {
                Title: 'Ficha Técnica AVANT LIMA',
                Author: 'AVANT LIMA Perú'
            },
            permissions: {
                printing: 'highResolution', modifying: false, copying: false, annotating: true,
                fillingForms: true, contentAccessibility: true, documentAssembly: true
            },
            userPassword: propiedadInfo.dni // Protegido con DNI
        });

        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });
        doc.on('error', reject);

        doc.fontSize(18).text('Ficha Técnica de Propiedad', { align: 'center' });
        doc.moveDown();

        doc.fontSize(12).text(`Propietario: ${propiedadInfo.name || 'N/A'}`);
        doc.text(`DNI: ${propiedadInfo.dni || 'N/A'}`);
        doc.text(`Teléfono: ${propiedadInfo.phoneNumber || 'N/A'}`);
        doc.text(`Email: ${propiedadInfo.email || 'N/A'}`);
        doc.moveDown();

        doc.fontSize(14).text('Detalles de la Propiedad:', { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(`Operación: ${propiedadInfo.operacion || 'N/A'}`);
        doc.text(`Dirección: ${propiedadInfo.direccion || 'N/A'}`);
        doc.text(`Distrito: ${propiedadInfo.distrito || 'N/A'}`);
        doc.text(`Tamaño: ${propiedadInfo.tamano || 'N/A'}`);
        doc.text(`Número Adicional: ${propiedadInfo.numeroAdicional || 'N/A'}`);
        doc.text(`Mensaje Personalizado QR: ${propiedadInfo.mensajePersonalizadoQR || 'N/A'}`);

        doc.end();
    });
};

// REDISEÑADA: enviarCorreoConfirmacion a enviarCorreoConArchivos
const enviarCorreoConArchivos = async (destinatarioEmail, asuntoCorreo, cuerpoCorreo, archivosAdjuntos = []) => {
    const transporter = nodemailer.createTransport({
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
        auth: {
            user: 'contacto@somosmarketingperu.com',
            pass: 'Somosmarketingperu00000000' // Contraseña de aplicación si está configurada, o la contraseña de la cuenta
        },
    });

    const mailOptions = {
        from: 'contacto@somosmarketingperu.com',
        to: destinatarioEmail,
        subject: asuntoCorreo,
        html: cuerpoCorreo,
        attachments: archivosAdjuntos.map(file => ({
            filename: file.filename,
            content: file.content
        }))
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(formatMessageLog('info', 'BOT -> EMAIL', `Correo enviado a ${destinatarioEmail} con asunto: ${asuntoCorreo}`));
    } catch (error) {
        console.error(formatMessageLog('error', 'BOT -> EMAIL', `Error al enviar correo a ${destinatarioEmail}: ${error.message}`));
        throw error;
    }
};

// CONSOLA ERROR GENERICO
const handleError = async (flowDynamic, step, error) => {
    console.error('❌ Error en nextStep:', {
        step,
        error: error?.message || 'Error desconocido',
        stack: error?.stack
    });
    await flowDynamic('❌ Error crítico. Escribe *INICIO* para comenzar de nuevo.');
    return true;
};

// 1. INICIO DE CONVERSACIÓN Y BIENVENIDA AVANT LIMA
const flujoBienvenida = addKeyword(['HOLA', 'OLA', 'BUENAS', 'menu', 'inicio', 'm'], { sensitive: false })
    .addAction(async (ctx, { flowDynamic, gotoFlow }) => {
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const nroTelefonoUsuario = ctx.from;
        const horaActual = Date.now();
        let infoRuta = rutasDeConversacion.get(nroTelefonoUsuario) || { validated: false };

        infoRuta.flujoAnterior = infoRuta.flujoActual;
        infoRuta.flujoActual = 'flujoBienvenida';
        infoRuta.lastInteraction = horaActual;
        rutasDeConversacion.set(nroTelefonoUsuario, infoRuta);

        // Chatbot: 👋 ¡Hola! Soy Luciana de AVANT LIMA Perú 🏙️. ¡Bienvenido(a) a nuestro servicio de Carteles Inteligentes QR para propiedades! Estoy aquí para ayudarte a vender o alquilar tu inmueble de forma efectiva.
        const welcomeMessages = [
            '👋 ¡Hola! Soy Luciana de AVANT LIMA Perú 🏙️. ¡Bienvenido(a) a nuestro servicio de Carteles Inteligentes QR para propiedades! Estoy aquí para ayudarte a vender o alquilar tu inmueble de forma efectiva.'
        ];

        await flowDynamic(welcomeMessages);
        console.log(formatMessageLog('sent', ctx.from, welcomeMessages.join('\n')));
    })
    // Chatbot: Por favor, revisa nuestros Términos y Condiciones (TyC) adjuntos...
    .addAnswer('Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo.', {
        //media: '/home/user/CB_MiroQR_INFO_V1/TyC Canales Digitales (set 2024) VF.pdf'
    }, async (ctx, { flowDynamic }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo. (Adjunto: TyC Canales Digitales (set 2024) VF.pdf)'));
    })
    // 2. ACEPTACIÓN DE TÉRMINOS Y CONDICIONES
    // Chatbot: 📌 ¿Estás de acuerdo con el servicio? Responde Sí para continuar 🙌.
    .addAnswer('📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, '📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const userResponse = ctx.body.trim().toLowerCase();
        const infoRuta = rutasDeConversacion.get(ctx.from);

        if (userResponse === 'sí' || userResponse === 'si') {
            console.log(formatMessageLog('info', ctx.from, 'Usuario aceptó TyC, redirigiendo a pregunta de explorar servicios inmobiliarios.'));
            // Redirige al flujo 3: Confirmación de Continuación del Servicio
            return gotoFlow(flujoContratarServiciosInmobiliarios);
        } else {
            const offerManualGuideMessage = 'Entendido. Si no aceptas los términos, no podemos continuar con el servicio. ¡Gracias por tu tiempo!';
            await flowDynamic(offerManualGuideMessage);
            console.log(formatMessageLog('sent', ctx.from, 'Usuario no aceptó TyC.'));
            return gotoFlow(flujoFinal_AVANTLIMA);
        }
    });

// 3. CONFIRMACIÓN DE CONTINUACIÓN DEL SERVICIO
const flujoContratarServiciosInmobiliarios = addKeyword(['sí', 'si', 'no'])
    .addAnswer(
        '🚀 ¿Deseas continuar para explorar nuestros servicios para tu propiedad? Responde **Sí** para continuar o **No** si no deseas hacerlo ahora.',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const respuesta = ctx.body.trim().toLowerCase();
            console.log('DEBUG: Respuesta en contratar servicios:', respuesta);
            
            if (respuesta === 'sí' || respuesta === 'si') {
                await flowDynamic('¡Perfecto! Vamos a proceder con la validación de tu identidad.');
                return gotoFlow(flujoValidacionDni);
            } else if (respuesta === 'no') {
                await flowDynamic('Entendido. Si cambias de opinión, no dudes en contactarnos.');
                return gotoFlow(flujoDespedida);
            } else {
                await flowDynamic('Por favor, responde con "Sí" o "No".');
                return gotoFlow(flujoContratarServiciosInmobiliarios);
            }
        }
    );

// 4. PROCESO DE VALIDACIÓN DE DNI (LOGIN)
const flujoValidacionDni = addKeyword([])
    .addAnswer(
        'Para continuar, por favor, ingresa tu número de DNI para validar tu identidad:',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));

            const dni = ctx.body.trim();
            if (!/^\d{8}$/.test(dni)) {
                const invalidFormatMessage = '⚠️ Formato de DNI inválido. Por favor, ingresa 8 dígitos numéricos.';
                await flowDynamic(invalidFormatMessage);
                console.log(formatMessageLog('sent', ctx.from, invalidFormatMessage));
                return gotoFlow(flujoValidacionDni);
            }

            let infoRuta = rutasDeConversacion.get(ctx.from) || {};
            infoRuta.dni = dni;
            rutasDeConversacion.set(ctx.from, infoRuta);

            console.log(`DEBUG: DNI capturado: ${dni}, redirigiendo a flujoPedirCodigoVerificacion`);
            return gotoFlow(flujoPedirCodigoVerificacion);
        }
    );

// 4.1 FLUJO PARA PEDIR EL CÓDIGO DE VERIFICACIÓN
const flujoPedirCodigoVerificacion = addKeyword([])
    .addAnswer(
        'Por favor, ingresa el código de verificación de tu DNI (el último dígito en la parte superior derecha de tu DNI):',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));

            const codigoVerificacionUsuario = ctx.body.trim();
            const infoRuta = rutasDeConversacion.get(ctx.from) || {};
            const dniGuardado = infoRuta.dni;
            const token = 'fea232162c6106d5cd603a2c9e91fab25e1dc1ee15b8b720b63bbeb53c839ab7';

            if (!/^\d{1}$/.test(codigoVerificacionUsuario)) {
                await flowDynamic('⚠️ Formato de código de verificación inválido. Por favor, ingresa un único dígito numérico.');
                return gotoFlow(flujoPedirCodigoVerificacion);
            }

            try {
                const respuesta = await validarDni(dniGuardado, token);

                if (respuesta && respuesta.success && respuesta.data && respuesta.data.codigo_verificacion) {
                    const codigoVerificacionAPI = String(respuesta.data.codigo_verificacion);

                    if (codigoVerificacionAPI === codigoVerificacionUsuario) {
                        const nombreCompleto = respuesta.data.nombre_completo;
                        const successMessage = `✅ ¡Gracias! Tu DNI ha sido validado, ${nombreCompleto}.`;
                        await flowDynamic(successMessage);

                        rutasDeConversacion.set(ctx.from, { ...infoRuta, validated: true, name: nombreCompleto, verificationCode: codigoVerificacionAPI, email: respuesta.data.email });

                        await flowDynamic([
                            `✨ *¡Gracias ${nombreCompleto}!* ✨\n\n`,
                            '*PROCESO DE GENERACIÓN (5 minutos)*\n',
                            'Te haré algunas preguntas sobre tu propiedad.\n',
                            'Al finalizar recibirás tu PDF con código QR.\n\n'
                        ].join(''));

                        return gotoFlow(flujoSeleccionarOperacion);
                    }
                }
                await flowDynamic('❌ Lo siento, no pudimos validar tu DNI o el código de verificación no está disponible. Por favor, verifica el número e inténtalo de nuevo.');
                return gotoFlow(flujoValidacionDni);
            } catch (error) {
                console.error('Error al validar DNI con código de verificación:', error);
                await flowDynamic('⚠️ Ocurrió un error técnico al validar tu DNI. Por favor, inténtalo más tarde.');
                return gotoFlow(flujoValidacionDni);
            }
        }
    );

// TIEMPO DE ESPERA PARA TODOS LOS FLUJOS
const TIMEOUT = 300000; // 5 minutos

// 5.1 SELECCIÓN DE OPERACIÓN (ALQUILAR/VENDER)
const flujoSeleccionarOperacion = addKeyword(['1', '2'])
    .addAnswer(
        [
            '¿Qué deseas hacer?',
            '1️⃣ Alquilar mi propiedad 🏠',
            '2️⃣ Vender mi propiedad 💰',
            'Responde con el número de tu elección (1 o 2):'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const opcion = ctx.body.trim();
            console.log('DEBUG: Opción de operación seleccionada:', opcion);
            
            if (opcion === '1' || opcion === '2') {
                const operacion = opcion === '1' ? 'Alquilar' : 'Vender';
                await flowDynamic(`Has seleccionado ${operacion} tu propiedad.`);
                return gotoFlow(flujoSeleccionServicio);
            } else {
                await flowDynamic('Por favor, selecciona 1 o 2.');
                return gotoFlow(flujoSeleccionarOperacion);
            }
        }
    );

// 5.2 SELECCIÓN DE SERVICIO (BÁSICO/PREMIUM)
const flujoSeleccionServicio = addKeyword(['1', '2'])
    .addAnswer(
        [
            'SERVICIOS DISPONIBLES',
            '🔹 Servicio Básico (GRATIS) 🔹',
            'Banner QR tamaño estándar 📄',
            'Plantilla básica',
            'Implementación en 24 horas ⚡',
            '',
            '💎 Servicio Premium (S/ 100) 💎',
            'Banner QR personalizado 🎨',
            'Chatbot con tu información 🤖',
            'Integración con redes sociales 📱',
            'Asesoría 24/7 📞',
            '',
            'REQUISITOS:',
            'Dirección exacta 📍',
            'Distrito 🗺️',
            'Tamaño de la propiedad 📏',
            'Número de contacto adicional (opcional) 📱',
            '',
            '¿Qué servicio prefieres?',
            '1️⃣ Básico (GRATIS)',
            '2️⃣ Premium (S/ 100)'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const opcion = ctx.body.trim();
            console.log('DEBUG: Opción de servicio seleccionada:', opcion);
            
            if (opcion === '1' || opcion === '2') {
                const servicio = opcion === '1' ? 'Básico' : 'Premium';
                await flowDynamic(`Has seleccionado el Servicio ${servicio}.`);
                
                let infoRuta = rutasDeConversacion.get(ctx.from) || {};
                infoRuta.servicio = servicio;
                rutasDeConversacion.set(ctx.from, infoRuta);
                
                return gotoFlow(clientFlow);
            } else {
                await flowDynamic('Por favor, selecciona 1 o 2.');
                return gotoFlow(flujoSeleccionServicio);
            }
        }
    );

const flujoConfirmarServicios = addKeyword(['sí', 'si', 'no'])
    .addAnswer(
        '¿Deseas continuar para explorar nuestros servicios para tu propiedad?',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const respuesta = ctx.body.trim().toLowerCase();
            console.log('DEBUG: Respuesta de confirmación:', respuesta);
            
            if (respuesta === 'sí' || respuesta === 'si') {
                await flowDynamic('¡Excelente! Vamos a proceder con la contratación.');
                return gotoFlow(flujoContratarServiciosInmobiliarios);
            } else if (respuesta === 'no') {
                await flowDynamic('Entendido. Si cambias de opinión, no dudes en contactarnos.');
                return gotoFlow(flujoDespedida);
            } else {
                await flowDynamic('Por favor, responde con "Sí" o "No".');
                return gotoFlow(flujoConfirmarServicios);
            }
        }
    );

// 6. RECOPILACIÓN DE DETALLES DE LA PROPIEDAD (PARA AMBOS SERVICIOS)
// Sub-flujo: Pregunta la Dirección
const flujoPreguntaDireccion = addKeyword(['__internal_ask_address__'])
    .addAnswer(
        [
            '*¿Cuál es la dirección exacta de tu propiedad?* 📍\n',
            'Ejemplo: Av. Javier Prado 1234, San Isidro'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));
            const direccion = ctx.body?.trim();
            if (!direccion || direccion.length < 5) {
                await flowDynamic('❌ Por favor, ingresa una dirección válida');
                return fallBack();
            }
            await state.update({ direccion: direccion });
            rutasDeConversacion.set(ctx.from, { ...rutasDeConversacion.get(ctx.from), direccion: direccion });
            await flowDynamic('✅ Dirección registrada\n\n');
            return gotoFlow(flujoPreguntaDistrito);
        }
    );

// Sub-flujo: Pregunta el Distrito
const flujoPreguntaDistrito = addKeyword(['__internal_ask_district__'])
    .addAnswer(
        [
            '*¿En qué distrito está ubicada la propiedad?* 🗺️\n',
            'Ejemplo: San Isidro'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));
            const distrito = ctx.body?.trim();
            if (!distrito || distrito.length < 3) {
                await flowDynamic('❌ Por favor, ingresa un distrito válido');
                return fallBack();
            }
            await state.update({ distrito: distrito });
            rutasDeConversacion.set(ctx.from, { ...rutasDeConversacion.get(ctx.from), distrito: distrito });
            await flowDynamic('✅ Distrito registrado\n\n');
            return gotoFlow(flujoPreguntaTamano);
        }
    );

// Sub-flujo: Pregunta el Tamaño
const flujoPreguntaTamano = addKeyword(['__internal_ask_size__'])
    .addAnswer(
        [
            '*¿Cuál es el tamaño de la propiedad?* 📏\n',
            'Ejemplo: 120m2 o doscientos metros cuadrados'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));
            const tamano = ctx.body?.trim();
            if (!tamano) {
                await flowDynamic('❌ Por favor, ingresa el tamaño de la propiedad');
                return fallBack();
            }
            await state.update({ tamano: tamano });
            rutasDeConversacion.set(ctx.from, { ...rutasDeConversacion.get(ctx.from), tamano: tamano });
            await flowDynamic('✅ Tamaño registrado\n\n');
            return gotoFlow(flujoPreguntaMensajePersonalizado);
        }
    );

// Sub-flujo: Pregunta el Mensaje Personalizado
const flujoPreguntaMensajePersonalizado = addKeyword(['__internal_ask_custom_message__'])
    .addAnswer(
        [
            '*Para tu cartel QR, ¿qué mensaje personalizado quieres que vea el interesado al escanear?* 💬\n',
            'Ejemplo: "Hola, me interesa tu propiedad. ¡Envíame más fotos!"'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));
            const mensajePersonalizado = ctx.body?.trim();
            if (!mensajePersonalizado || mensajePersonalizado.length < 5) {
                await flowDynamic('❌ Por favor, ingresa un mensaje válido de al menos 5 caracteres.');
                return fallBack();
            }
            await state.update({ mensajePersonalizado: mensajePersonalizado });
            rutasDeConversacion.set(ctx.from, { ...rutasDeConversacion.get(ctx.from), mensajePersonalizado: mensajePersonalizado });
            await flowDynamic('✅ Mensaje personalizado registrado\n\n');
            return gotoFlow(flujoPreguntaNumeroAdicional);
        }
    );

// Sub-flujo: Pregunta el Número Adicional
const flujoPreguntaNumeroAdicional = addKeyword(['__internal_ask_additional_phone__'])
    .addAnswer(
        [
            '*¿Deseas agregar un número de contacto adicional?* 📱\n',
            'Si no deseas agregar otro número, escribe NO\n',
            'Ejemplo: 999888777'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('received', ctx.from, ctx.body));
            const numeroAdicional = ctx.body?.trim().toUpperCase();
            let finalNumeroAdicional = null;

            if (numeroAdicional === 'NO') {
                await flowDynamic('✅ Número adicional registrado (No se agregó número adicional)\n\n');
            } else if (!/^\d{9}$/.test(numeroAdicional)) {
                await flowDynamic('❌ Por favor, ingresa un número válido de 9 dígitos o escribe NO');
                return fallBack();
            } else {
                finalNumeroAdicional = numeroAdicional;
                await flowDynamic('✅ Número adicional registrado\n\n');
            }
            await state.update({ numeroAdicional: finalNumeroAdicional });
            rutasDeConversacion.set(ctx.from, { ...rutasDeConversacion.get(ctx.from), numeroAdicional: finalNumeroAdicional });
            
            const infoRuta = rutasDeConversacion.get(ctx.from) || {};
            if (infoRuta.servicio === 'Premium') {
                await flowDynamic('💳 Proceso de Pago Premium 💳\nPara activar todas las funcionalidades premium, realiza el pago de S/ 100:\n1️⃣ Yape: 999-999-999\n2️⃣ Plin: 999-999-999\nEnvía una foto del comprobante para continuar.');
                return gotoFlow(paymentFlow);
            } else { // Servicio Básico
                await flowDynamic([
                    '🎉 *¡Excelente! Tenemos toda la información necesaria para tu servicio Básico* 🎉\n\n',
                    'Generando tu cartel QR gratuito...\n',
                    'Este proceso tomará unos segundos.'
                ].join('\n'));
                return gotoFlow(flujoFinal_AVANTLIMA);
            }
        }
    );

// El `clientFlow` original ahora solo será el punto de entrada a la secuencia de preguntas
const clientFlow = addKeyword(['__internal_client_flow_start__'])
    .addAction(async (ctx, { gotoFlow, flowDynamic }) => {
        const infoRuta = rutasDeConversacion.get(ctx.from) || {};
        if (infoRuta.name) {
            console.log(formatMessageLog('info', ctx.from, `Nombre (${infoRuta.name}) ya obtenido del DNI, saltando pregunta de nombre.`));
        }
        // Inicia el flujo de preguntas de la propiedad
        return gotoFlow(flujoPreguntaDireccion);
    });

// 7. PROCESO DE PAGO PREMIUM
const paymentFlow = addKeyword(['payment_flow_start']) // Keyword interno
    // Chatbot: 💳 Proceso de Pago Premium 💳 Para activar todas las funcionalidades premium...
    .addAnswer(
        [
            '💳 *Proceso de Pago Premium* 💳\n\n',
            'Para activar todas las funcionalidades premium, realiza el pago de S/ 100:\n\n',
            '1️⃣ Yape: 999-999-999\n',
            '2️⃣ Plin: 999-999-999\n\n',
            'Envía una foto del comprobante para continuar.'
        ].join(''),
        {
            capture: true,
            idle: TIMEOUT
        },
        async (ctx, { flowDynamic, state, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('sent', ctx.from, 'Solicitando comprobante de pago Premium.'));
            console.log(formatMessageLog('received', ctx.from, ctx.body));

            if (!ctx.message?.hasMedia) {
                await flowDynamic([
                    '❌ No se detectó ninguna imagen.\n',
                    'Por favor, envía una foto del comprobante de pago.'
                ].join('\n'));
                return fallBack();
            }

            const currentState = await state.getMyState();
            await state.update({
                ...currentState,
                paymentStatus: 'pending_verification',
                paymentTimestamp: new Date().toISOString()
            });

            // Chatbot: ✅ ¡Comprobante Recibido! Verificaremos tu pago...
            await flowDynamic([
                '✅ *¡Comprobante Recibido!*\\n',
                'Verificaremos tu pago y activaremos tu cuenta Premium.\\n',
                'Generando tu cartel QR y ficha técnica...'
            ].join(''));

            try {
                const propiedadInfo = rutasDeConversacion.get(ctx.from);
                const cartelBuffer = await generarCartelQRPDF(propiedadInfo, propiedadInfo.mensajePersonalizado, propiedadInfo.phoneNumber, 'premium');
                const fichaBuffer = await generarFichaTecnicaPDF(propiedadInfo);

                const asunto = '¡Tu Servicio Premium AVANT LIMA ha sido activado! Cartel QR y Ficha Técnica listos';
                const cuerpo = `Hola ${propiedadInfo.name || 'Cliente AVANT LIMA'},\n\n` +
                               `¡Felicidades! Tu servicio Premium ha sido activado. Adjuntamos el cartel QR personalizado y la ficha técnica detallada de tu propiedad. ¡Comienza a promocionar!\n\n` +
                               `\n\n--- Notas Importantes ---\n` +
                               `1. Este cartel QR y la ficha técnica son para uso personal en la promoción de su propiedad.\n` +
                               `2. La información mostrada se basa en los datos proporcionados por usted.\n` +
                               `3. Para cualquier consulta o soporte, contáctenos a través de nuestros canales oficiales.\n` +
                               `-----------------------`;

                await enviarCorreoConArchivos(
                    propiedadInfo.email,
                    asunto,
                    cuerpo,
                    [
                        { filename: 'Cartel_QR_AVANT_LIMA_Premium.pdf', content: cartelBuffer },
                        { filename: 'Ficha_Tecnica_AVANT_LIMA.pdf', content: fichaBuffer }
                    ]
                );

                // 8. GENERACIÓN Y ENVÍO DE CARTEL QR Y FICHA TÉCNICA (PARA PREMIUM)
                // Chatbot: ✨ ¡Tu cartel QR y la ficha técnica están listos! ✨ Te enviaré ambos archivos...
                await flowDynamic([
                    '✨ *¡Tu cartel QR y la ficha técnica están listos!* ✨\n\n',
                    'Te hemos enviado ambos archivos a tu correo electrónico registrado.'
                ].join(''));
                // Pasa al flujo 9: Flujo Final
                return gotoFlow(flujoFinal_AVANTLIMA);
            } catch (error) {
                return handleError(flowDynamic, 'generacion_y_envio_premium', error);
            }
        }
    );

// 9. FLUJO FINAL DE LA CONVERSACIÓN AVANT LIMA (GENERAL)
const flujoFinal_AVANTLIMA = addKeyword([])
    // Chatbot: ¡Ha sido un placer asistirte con AVANT LIMA! Si necesitas algo más...
    .addAnswer(
        '¡Ha sido un placer asistirte con *AVANT LIMA*! Si necesitas algo más, no dudes en escribir *Hola*.',
        null,
        async (ctx, { flowDynamic, endFlow }) => {
            console.log(formatMessageLog('sent', ctx.from, 'Mensaje final de despedida AVANT LIMA.'));
            rutasDeConversacion.delete(ctx.from); // Limpiar la sesión del usuario
            return endFlow();
        }
    );
    
// Configuración Principal
const main = async () => {
    // Estado temporal de usuarios (memoria volátil)
    rutasDeConversacion.clear(); // Borra el Map para reiniciar el estado de todos los usuarios
    const adapterDB = new MockAdapter();
    const adapterFlows = createFlow([
        flujoBienvenida,                    // 1. Bienvenida y TyC
        flujoContratarServiciosInmobiliarios, // 2. Pregunta si desea explorar servicios
        flujoValidacionDni,                 // 3. Validación de DNI
        flujoPedirCodigoVerificacion,       // 4. Código de verificación
        flujoSeleccionarOperacion,          // 5. Selección Alquilar/Vender
        flujoSeleccionServicio,             // 6. Selección Básico/Premium
        clientFlow,                         // Punto de entrada para la recopilación de datos de propiedad
        flujoPreguntaDireccion,             // Sub-flujo de dirección
        flujoPreguntaDistrito,              // Sub-flujo de distrito
        flujoPreguntaTamano,                // Sub-flujo de tamaño
        flujoPreguntaMensajePersonalizado,  // Sub-flujo de mensaje personalizado
        flujoPreguntaNumeroAdicional,       // Sub-flujo de número adicional
        paymentFlow,                        // 7. Proceso de pago (solo Premium)
        flujoFinal_AVANTLIMA                // 8. Mensaje final
    ]);
    const adapterProvider = createProvider(BaileysProvider);

    createBot({
        flow: adapterFlows,
        provider: adapterProvider,
        database: adapterDB
    });

    QRPortalWeb();
};

main();