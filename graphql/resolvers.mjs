// graphql/resolvers.mjs
import moment from 'moment-timezone';
import path from 'path';
import fs from 'fs';
import { createPubSub } from '@graphql-yoga/subscription';
import cloudinary from '../utils/cloudinary.mjs';
import User from '../models/User.js';
import Appointment from '../models/Appointment.js';
import sendEmailNotification from '../utils/emailService.js';
import { fileURLToPath } from 'url';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SECRET_KEY = process.env.JWT_SECRET_KEY || 'secret_Key';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pubsub = createPubSub();
const APPOINTMENTS_UPDATED = 'APPOINTMENTS_UPDATED';

const getFormattedAppointments = async (userEmail) => {
  const user = await User.findOne({ email: userEmail });
  const timezone = user?.timezone || "UTC";
  const appointments = await Appointment.find({ participants: userEmail });

  return appointments.map((appointment) => {
    const plain = appointment.toObject();
    const dateStr = moment(plain.date).format("YYYY-MM-DD");
    const combined = `${dateStr}T${plain.time}`;
    const momentObj = moment.utc(combined, "YYYY-MM-DDTHH:mm");

    if (!momentObj.isValid()) {
      return { ...plain, id: plain._id.toString(), date: "Invalid", time: "Invalid" };
    }

    return {
      ...plain,
      id: plain._id.toString(),
      date: momentObj.clone().tz(timezone).format("YYYY-MM-DD"),
      time: momentObj.clone().tz(timezone).format("hh:mm A"),
    };
  });
};

const checkAuth = (user) => {

  if (!user) throw new Error("Not authenticated");
};

const resolvers = {
  Query: {
    getAppointments: async (_, { userEmail }, { user }) => {
      //const userFromDb = await User.findById(user)
      checkAuth(user);
      return await getFormattedAppointments(userEmail);
    },
    getAppointment: async (_, { id, userEmail }, { user }) => {
      checkAuth(user);
      const appointment = await Appointment.findById(id);
      if (!appointment || !appointment.participants.includes(userEmail)) {
        throw new Error("Unauthorized access");
      }
      return (await getFormattedAppointments(userEmail)).find(app => app.id === id);
    },
    getUser: async (_, __, { user }) => {
      checkAuth(user);
      return await User.findById(user.id);
    }
  },

  Mutation: {
    createAppointment: async (_, { title, description, date, time, participants, file }, { user }) => {
      checkAuth(user);

      let attachment = null;
      let contentPreview = null;

      if (file) {
        // const { createReadStream, filename } = file;
        // const stream = createReadStream();
        // const ext = path.extname(filename).toLowerCase();
        // const allowedExtensions = ['.pdf', '.doc', '.docx', '.txt'];

        // if (!allowedExtensions.includes(ext)) {
        //   throw new Error("Unsupported file type.");
        // }

        const tempPath = path.join(__dirname, "../public", file);
        // const out = fs.createWriteStream(tempPath);
        // stream.pipe(out);

        // await new Promise((resolve, reject) => {
        //   out.on("finish", resolve);
        //   out.on("error", reject);
        // });

        const { secure_url } = await cloudinary.uploader.upload(tempPath, {
          folder: "appointments",
          resource_type: "raw",
          use_filename: true,
          unique_filename: false
        });

        contentPreview = fs.existsSync(tempPath)
          ? fs.readFileSync(tempPath, 'utf8').substring(0, 1024)
          : null;

        attachment = { url: secure_url, filename: file };
        //fs.unlinkSync(tempPath);
      }

      const newAppointment = new Appointment({
        title,
        description,
        date,
        time,
        participants,
        status: 'Scheduled',
        attachment,
        contentPreview
      });

      const saved = await newAppointment.save();

      await sendEmailNotification(participants, "New Appointment Created", `Appointment "${title}" on ${date} at ${time}.`);

      for (const email of participants) {
        const updated = await getFormattedAppointments(email);
        pubsub.publish(`${APPOINTMENTS_UPDATED}_${email}`, {
          appointmentsUpdated: updated
        });
      }

      return { ...saved.toObject(), id: saved._id.toString() };
    },

    updateAppointment: async (_, { id, ...updates }, { user }) => {
      console.log(user)
      checkAuth(user);
      const user1 = await User.findById(user);
      console.log(user1.email)
      const appointment = await Appointment.findById(id);
      if (!appointment || !appointment.participants.includes(user1.email)) {
        throw new Error("Unauthorized");
      }

      Object.assign(appointment, updates);
      await appointment.save();

      await sendEmailNotification(appointment.participants, "Appointment Updated", `Appointment "${appointment.title}" updated.`);

      for (const email of appointment.participants) {
        const updatedList = await getFormattedAppointments(email);
        pubsub.publish(`${APPOINTMENTS_UPDATED}_${email}`, {
          appointmentsUpdated: updatedList
        });
      }

      return appointment;
    },

    rescheduleAppointment: async (_, { id, date, time }, { user }) => {
      checkAuth(user);
      console.log("Rescheduled Appointment", user)
      const user1 = await User.findById(user);
      console.log(user1)
      const appointment = await Appointment.findById(id);
      console.log(appointment)
      if (!appointment || !appointment.participants.includes(user1.email)) {
        throw new Error("Unauthorized");
      }

      const newDateTime = new Date(`${date}T${time}`);
      if (newDateTime < new Date()) {
        throw new Error("Cannot reschedule to the past");
      }

      appointment.date = date;
      appointment.time = time;
      appointment.status = 'Rescheduled';
      await appointment.save();

      await sendEmailNotification(appointment.participants, "Appointment Rescheduled", `Appointment "${appointment.title}" has been rescheduled.`);

      for (const email of appointment.participants) {
        const updated = await getFormattedAppointments(email);
        pubsub.publish(`${APPOINTMENTS_UPDATED}_${email}`, {
          appointmentsUpdated: updated
        });
      }

      return appointment;
    },

    cancelAppointment: async (_, { id }, { user }) => {
      checkAuth(user);
      console.log(user);
      const user1 = await User.findById(user);
      const appointment = await Appointment.findById(id);
      if (!appointment || !appointment.participants.includes(user1.email)) {
        throw new Error("Unauthorized");
      }

      appointment.status = 'Canceled';
      await appointment.save();

      await sendEmailNotification(appointment.participants, "Appointment Canceled", `Appointment "${appointment.title}" has been canceled.`);

      for (const email of appointment.participants) {
        const updated = await getFormattedAppointments(email);
        pubsub.publish(`${APPOINTMENTS_UPDATED}_${email}`, {
          appointmentsUpdated: updated
        });
      }

      return appointment;
    },

    deleteAppointment: async (_, { id }, { user }) => {
      checkAuth(user);
      console.log(user);
      const user1 = await User.findById(user)
      const appointment = await Appointment.findById(id);
      if (!appointment || !appointment.participants.includes(user1.email)) {
        throw new Error("Unauthorized");
      }

      await Appointment.findByIdAndDelete(id);
      await sendEmailNotification(appointment.participants, "Appointment Deleted", `Appointment "${appointment.title}" has been deleted.`);

      for (const email of appointment.participants) {
        const updated = await getFormattedAppointments(email);
        pubsub.publish(`${APPOINTMENTS_UPDATED}_${email}`, {
          appointmentsUpdated: updated
        });
      }

      return "Appointment successfully deleted.";
    },

    createUser: async (_, { name, email, timezone, password }) => {
      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) throw new Error("User already exists.");

      // Hash password before saving
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create and save the new user
      const newUser = new User({
        name,
        email,
        timezone,
        password: hashedPassword, // Save the hashed password
      });

      await newUser.save();

      // Generate a JWT token for the newly created user
      const token = jwt.sign(
        { userId: newUser.id, email: newUser.email },
        SECRET_KEY,
        { expiresIn: '1h' } // Token expires in 1 hour
      );

      // Return user and token in the response
      return {
        user: newUser,
        token,
      };
    },


    updateUserTimezone: async (_, { id, timezone }, { user }) => {
      checkAuth(user);
      const updated = await User.findByIdAndUpdate(id, { timezone }, { new: true });
      return updated;
    }
  },

  Subscription: {
    appointmentsUpdated: {
      subscribe: async (_, { userEmail }, context) => {
        console.log("context", context)
        const userEmailFromContext = context.user.email

        if (!context || userEmailFromContext !== userEmail) throw new Error("Unauthorized");
        return pubsub.subscribe(`${APPOINTMENTS_UPDATED}_${userEmail}`);
      },
      resolve: (payload) => payload.appointmentsUpdated
    },
  },
};

export { pubsub };
export default resolvers;
