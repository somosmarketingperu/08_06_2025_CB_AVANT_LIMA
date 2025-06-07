const { createBot, createProvider, createFlow, addKeyword, addAnswer } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const https = require('https');

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
    // Aseguramos que 'message' sea una cadena
    const messageContent = typeof message === 'string' ? message : JSON.stringify(message);
    return `[${time}] ${directionLabel} ${from}: ${messageContent}`;
};

// Función para obtener la fecha de entrega (sábado o domingo más cercano)
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

// FLUJOS DE CONVERSACIÓN

// Flujo Final para la venta de bolsas
const flujoFinal_Bolsas = addKeyword(['finalizar', 'gracias', 'pedido listo'])
    .addAnswer('¡Listo! 🎉 Tu pedido está en proceso. En breve nos pondremos en contacto contigo para coordinar los detalles finales de la entrega. ¡Gracias por tu compra! 🛒', { capture: false }, async (ctx, { flowDynamic }) => {
        // CONSOLE.LOG PARA MENSAJE RECIBIDO (ACTIVA ESTE FLUJO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));
         // CONSOLE.LOG PARA MENSAJE ENVIADO (MENSAJE FINAL)
        console.log(formatMessageLog('sent', ctx.from, '¡Listo! 🎉 Tu pedido está en proceso. En breve nos pondremos en contacto contigo para coordinar los detalles finales de la entrega. ¡Gracias por tu compra! 🛒'));


        const finalMessages = [
            '📌 **¿Tienes dudas?**',
            'Contáctanos al +51 999 999 999 📱.',
            'Correo: contacto@somosmarketingperu.com 📧.'
        ];
        await flowDynamic(finalMessages);
        // CONSOLE.LOG PARA MENSAJE ENVIADO (INFO CONTACTO)
        console.log(formatMessageLog('sent', ctx.from, finalMessages.join('\n')));
    });

// Flujo para preguntar la cantidad de paquetes
const flujoPreguntaCantidad = addKeyword([])
    .addAnswer('¿Cuántos paquetes de bolsas deseas ordenar? (Cada paquete contiene 100 unidades y cuesta S/15. Pedido mínimo para envío sin recargo es de 3 paquetes).', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Pregunta la cantidad de paquetes de bolsas.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const cantidadStr = ctx.body.trim();
        const cantidad = parseInt(cantidadStr, 10);
        const precioUnitario = 15;
        const recargoEnvio = 7;
        let totalPrice = 0;
        let message = '';
        let infoRuta = rutasDeConversacion.get(ctx.from) || {};

        if (isNaN(cantidad) || cantidad <= 0) {
            await flowDynamic('❌ Por favor, ingresa un número válido y mayor a cero.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Número inválido.'));
            return fallBack();
        }

        if (cantidad >= 3) {
            totalPrice = cantidad * precioUnitario;
            message = `¡Excelente! Has elegido ${cantidad} paquetes. El total a pagar es de *S/${totalPrice.toFixed(2)}* (sin recargo de envío).`;
        } else {
            totalPrice = (cantidad * precioUnitario) + recargoEnvio;
            message = `Has elegido ${cantidad} paquete(s). El total a pagar es de *S/${totalPrice.toFixed(2)}* (incluye S/7 de recargo por envío a Lima).`;
        }

        infoRuta.quantity = cantidad;
        infoRuta.totalPrice = totalPrice;
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Cantidad y precio total actualizado para ${ctx.from}.`));

        await flowDynamic(message);
        console.log(formatMessageLog('sent', ctx.from, message));

        return gotoFlow(flujoRecopilacionDireccion);
    });

// Flujo para recopilar la dirección de entrega
const flujoRecopilacionDireccion = addKeyword([])
    .addAnswer('Por favor, ingresa tu dirección completa para la entrega (calle, número, distrito, referencia):', { capture: true }, async (ctx, { flowDynamic, gotoFlow }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando dirección de entrega.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const infoRuta = rutasDeConversacion.get(ctx.from);
        infoRuta.address = ctx.body;
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Dirección actualizada para ${ctx.from}.`));

        await flowDynamic('¡Dirección recibida! Un momento, por favor.');
        console.log(formatMessageLog('sent', ctx.from, 'Dirección recibida.'));

        return gotoFlow(flujoConfirmarEntrega);
    });

// Flujo para confirmar la entrega y mostrar resumen
const flujoConfirmarEntrega = addKeyword([])
    .addAnswer('Un momento, por favor, estoy procesando tu pedido...', null, async (ctx, { flowDynamic, gotoFlow }) => {
        const infoRuta = rutasDeConversacion.get(ctx.from);
        const estimatedDeliveryDate = getNextDeliveryDate();
        infoRuta.deliveryDate = estimatedDeliveryDate;
        rutasDeConversacion.set(ctx.from, infoRuta);

        const confirmationMessage = `Las entregas se realizan solo los sábados y domingos. Si hiciste tu pedido hoy, la entrega será el próximo *${estimatedDeliveryDate}*.` +
            `\n\n¿Confirmas tu pedido de *${infoRuta.quantity} paquete(s)* de bolsas negras` +
            ` para el día *${estimatedDeliveryDate}*` +
            ` en la dirección *${infoRuta.address}*` +
            ` por un total de *S/${infoRuta.totalPrice.toFixed(2)}* a pagar contraentrega?` +
            `\n\nResponde **Sí** para confirmar o **No** para modificar tu pedido.`;

        await flowDynamic(confirmationMessage);
        console.log(formatMessageLog('sent', ctx.from, confirmationMessage));
    })
    .addAnswer('Responde **Sí** para confirmar o **No** para modificar tu pedido.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('received', ctx.from, ctx.body));
        const userResponse = ctx.body.trim().toLowerCase();

        if (userResponse === 'sí' || userResponse === 'si') {
            await flowDynamic('¡Excelente! Tu pedido ha sido confirmado. Un asesor se pondrá en contacto contigo para coordinar los detalles finales de la entrega.');
            console.log(formatMessageLog('sent', ctx.from, 'Pedido confirmado.'));
            return gotoFlow(flujoFinal_Bolsas);
        } else if (userResponse === 'no') {
            await flowDynamic('Entendido. Puedes reiniciar el proceso de pedido escribiendo "Hola".');
            console.log(formatMessageLog('sent', ctx.from, 'Pedido no confirmado, reiniciando.'));
            return gotoFlow(flujoBienvenida);
        } else {
            await flowDynamic('❌ No entendí tu respuesta. Por favor, responde **Sí** o **No**.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Respuesta inválida en confirmación de entrega.'));
            return fallBack();
        }
    });

// Flujo de Validación de DNI
const flujoValidacionDni = addKeyword([]) // Se llega aquí por gotoFlow desde Bienvenida
    .addAnswer('Por favor, ingresa tu número de DNI para validar tu identidad:', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (LA PREGUNTA DEL DNI)
        console.log(formatMessageLog('sent', ctx.from, 'Por favor, ingresa tu número de DNI para validar tu identidad:'));

        // CONSOLE.LOG PARA MENSAJE RECIBIDO (LA RESPUESTA DEL USUARIO CON EL DNI)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const dni = ctx.body.trim();
        // El token y la llamada a la API se moverán al siguiente flujo

        // Validar formato del DNI
        if (!/^\d{8}$/.test(dni)) {
            const invalidFormatMessage = '⚠️ Formato de DNI inválido. Por favor, ingresa 8 dígitos numéricos.';
            await flowDynamic(invalidFormatMessage);
            // CONSOLE.LOG PARA MENSAJE ENVIADO (ERROR DE FORMATO)
            console.log(formatMessageLog('sent', ctx.from, invalidFormatMessage));
            return fallBack();
        }

        // Guardar el DNI en el estado de conversación para el siguiente paso
        let infoRuta = rutasDeConversacion.get(ctx.from) || {};
        infoRuta.dni = dni;
        rutasDeConversacion.set(ctx.from, infoRuta);

        // Redirigir al nuevo flujo para pedir el código de verificación
        return gotoFlow(flujoPedirCodigoVerificacion);
    });

// Nuevo Flujo para pedir el código de verificación
const flujoPedirCodigoVerificacion = addKeyword([])
    .addAnswer('Por favor, ingresa el *código de verificación* de tu DNI (el último dígito en la parte superior derecha de tu DNI):', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando código de verificación del DNI.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const codigoVerificacionUsuario = ctx.body.trim();
        const infoRuta = rutasDeConversacion.get(ctx.from) || {};
        const dniGuardado = infoRuta.dni;
        const token = 'fea232162c6106d5cd603a2c9e91fab25e1dc1ee15b8b720b63bbeb53c839ab7'; // Token de Apiperu

        // Validar formato del código de verificación (debe ser un solo dígito numérico)
        if (!/^\d{1}$/.test(codigoVerificacionUsuario)) {
            await flowDynamic('⚠️ Formato de código de verificación inválido. Por favor, ingresa un *único dígito numérico*.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Código de verificación inválido.'));
            return fallBack();
        }

        try {
            const respuesta = await validarDni(dniGuardado, token);

            if (respuesta && respuesta.success && respuesta.data && respuesta.data.codigo_verificacion) {
                const codigoVerificacionAPI = String(respuesta.data.codigo_verificacion); // Asegurar que sea string para la comparación

                if (codigoVerificacionAPI === codigoVerificacionUsuario) {
                    const nombreCompleto = respuesta.data.nombre_completo;
                    const successMessage = `✅ ¡Gracias! Tu DNI ha sido validado, ${nombreCompleto}.`;
                    await flowDynamic(successMessage);
                    console.log(formatMessageLog('sent', ctx.from, successMessage));

                    rutasDeConversacion.set(ctx.from, { ...infoRuta, validated: true, name: nombreCompleto, verificationCode: codigoVerificacionAPI });

                    return gotoFlow(flujoPreguntaCantidad);
                } else {
                    const validationFailedMessage = '❌ El código de verificación no coincide. Por favor, verifica tu número de DNI y el código e inténtalo de nuevo.';
                    await flowDynamic(validationFailedMessage);
                    console.log(formatMessageLog('sent', ctx.from, '❌ Código de verificación incorrecto.'));
                    return fallBack();
                }
            } else {
                const validationFailedMessage = '❌ Lo siento, no pudimos validar tu DNI o el código de verificación no está disponible. Por favor, verifica el número e inténtalo de nuevo.';
                await flowDynamic(validationFailedMessage);
                console.log(formatMessageLog('sent', ctx.from, '❌ Validación de DNI/código fallida desde la API.'));
                return fallBack();
            }
        } catch (error) {
            console.error('Error al validar DNI con código de verificación:', error);
            const errorMessage = '⚠️ Ocurrió un error técnico al validar tu DNI. Por favor, inténtalo más tarde.';
            await flowDynamic(errorMessage);
            console.log(formatMessageLog('sent', ctx.from, errorMessage));
            return fallBack();
        }
    });

// Flujo para la pregunta de contratar servicios (adaptado para bolsas)
const flujoContratarServicios_Bolsas = addKeyword([])
    .addAnswer(
        '🚀 ¿Deseas realizar tu pedido de bolsas de desecho de forma rápida y segura con nosotros? Responde **Sí** para continuar o **No** si no deseas ordenar ahora. (Tiempo de espera: 60 segundos)',
        { idle: 60000, capture: true },
        async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('sent', ctx.from, 'Pregunta si desea realizar pedido de bolsas (después de pausa).'));
            console.log(formatMessageLog('received', ctx.from, ctx.body));

            const userResponse = ctx.body ? ctx.body.trim().toLowerCase() : '';

            if (ctx.idle) {
                await flowDynamic(`⌛ ¡Parece que no recibimos tu respuesta! Si cambias de opinión, ¡siempre puedes escribir "Hola" para regresar y hacer tu pedido!`);
                return gotoFlow(flujoFinal_Bolsas);
            } else if (userResponse === 'sí' || userResponse === 'si') {
                return gotoFlow(flujoValidacionDni);
            } else if (userResponse === 'no') {
                await flowDynamic('Entendido. No hay problema. ¡Gracias por tu tiempo!');
                return gotoFlow(flujoFinal_Bolsas);
            } else {
                return fallBack('❌ No entendí tu respuesta. Por favor, responde **Sí** o **No**.');
            }
        }
    );

// Flujo Bienvenida
const flujoBienvenida = addKeyword(['HOLA', 'OLA', 'BUENAS', 'menu', 'inicio', 'm'], { sensitive: false })
    .addAction(async (ctx, { flowDynamic, gotoFlow }) => {
        // CONSOLE.LOG PARA MENSAJE RECIBIDO (ACTIVA ESTE FLUJO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        // CONSOLE.LOG PARA DEBUG: Ver el estado actual de rutasDeConversacion
        console.log('DEBUG: Estado actual de rutasDeConversacion al iniciar el flujoBienvenida:', Array.from(rutasDeConversacion.entries()));


        const nroTelefonoUsuario = ctx.from;
        const horaActual = Date.now();
        let infoRuta = rutasDeConversacion.get(nroTelefonoUsuario) || { validated: false };

        //Actualiza flujo anterior y la ultima interaccion
        const flujoActual = infoRuta.flujoActual || null;
        infoRuta.flujoAnterior = flujoActual;
        infoRuta.flujoActual = 'flujoBienvenida';

        // Actualizar última interacción
        infoRuta.lastInteraction = horaActual;

        //Se actualiza con la informacion actual
        rutasDeConversacion.set(nroTelefonoUsuario, infoRuta);

        const welcomeMessages = [
            '👋 ¡Hola! Te saluda tu **Asesor de Ventas** especializado en **Bolsas de Desecho** 🗑️✨.',
            'Ofrecemos paquetes de 100 unidades de bolsas negras (60x150cm) a solo *S/15* cada uno.',
            '',
            '📦 **CONDICIONES DE VENTA Y ENTREGA:**',
            '✅ Las entregas se realizan únicamente los **sábados y domingos**.',
            '✅ Si solo deseas *un paquete*, se aplicará un recargo de *S/7* por envío a Lima.',
            '✅ Para pedidos de *3 paquetes o más*, el envío es **sin recargo**.',
            '',
            '¡Simplifica tu compra y recibe tus bolsas en casa! 🚚',
        ];

        // Mensaje de bienvenida con beneficios
        await flowDynamic(welcomeMessages);
        // CONSOLE.LOG PARA MENSAJE ENVIADO
        console.log(formatMessageLog('sent', ctx.from, welcomeMessages.join('\n'))); // Unimos para un log legible

        // NOTA: Ya no redirigimos a flujoValidacionDni aquí.
        // La lógica para esperar la respuesta "Sí" y redirigir va en el siguiente addAnswer.
    })
    .addAnswer('Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo.', {
        //media: '/home/user/CB_MiroQR_INFO_V1/TyC Canales Digitales (set 2024) VF.pdf'
    }, async (ctx, { flowDynamic }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (EL PDF Y LA INSTRUCCIÓN)
        console.log(formatMessageLog('sent', ctx.from, 'Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo. (Adjunto: TyC Canales Digitales (set 2024) VF.pdf)'));
    })
    .addAnswer('📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (LA PREGUNTA DEL ACUERDO)
        console.log(formatMessageLog('sent', ctx.from, '📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.'));

        // CONSOLE.LOG PARA MENSAJE RECIBIDO (LA RESPUESTA DEL USUARIO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const userResponse = ctx.body.trim().toLowerCase();
        const infoRuta = rutasDeConversacion.get(ctx.from); // Recuperar estado actualizado

        if (userResponse === 'sí' || userResponse === 'si') {
            // El usuario respondió "Sí"
            // No es necesario infoRuta.validated aquí, lo haremos en el flujoValidacionDni
            console.log(formatMessageLog('info', ctx.from, 'Usuario aceptó TyC, redirigiendo a pregunta de pedido.'));

            // NUEVA PREGUNTA: ¿Deseas realizar un pedido?
            return gotoFlow(flujoContratarServicios_Bolsas);

        } else {
            // El usuario no respondió "Sí" a los TyC
            const offerManualGuideMessage = 'Entendido. Si no aceptas los términos, no podemos continuar con el servicio de compra. ¡Gracias por tu tiempo!';
            await flowDynamic(offerManualGuideMessage);
            console.log(formatMessageLog('sent', ctx.from, 'Usuario no aceptó TyC.'));
            return gotoFlow(flujoFinal_Bolsas);
        }
    });

// Configuración Principal
const main = async () => {
    // Estado temporal de usuarios (memoria volátil)
    rutasDeConversacion.clear(); // Borra el Map para reiniciar el estado de todos los usuarios
    const adapterDB = new MockAdapter();
    const adapterFlows = createFlow([
        flujoBienvenida, // Asegura que el flujo de bienvenida sea el primero
        flujoValidacionDni, // flujoValidacionDni debería estar antes
        flujoPedirCodigoVerificacion, // Añadimos el nuevo flujo aquí
        flujoPreguntaCantidad,
        flujoRecopilacionDireccion,
        flujoConfirmarEntrega,
        flujoFinal_Bolsas,
        flujoContratarServicios_Bolsas
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
